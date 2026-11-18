//! async-claim-lock: the lock script of RFC 0001 "Fiber async receive".
//!
//! A cell guarded by this lock can be spent in exactly two ways, neither of
//! which checks a signature. The script only constrains where the value goes:
//!
//! * claim  — the witness carries the 32-byte payment preimage; output 0 must
//!   pay the receiver, output 1 must return any change to the LSP.
//! * refund — the witness lock is empty; the input `since` must be an absolute
//!   timestamp not earlier than `expiry`; output 0 must pay the LSP.
//!
//! In both cases the guarded cell must be the only input of the transaction.
//! The payout rules look at outputs, and an output can only be trusted to be
//! *this* cell's payout if nothing else in the transaction could be asking
//! for the same output: another claim cell, an older or newer version of this
//! script, or a cell of the payee's own whose lock accepts "an output pays me
//! at least as much" (anyone-can-pay). With a single input there is no other
//! script to share an output with. The fee comes out of the cell itself.
//!
//! args layout (89 bytes):
//!
//! | field              | bytes | meaning                                         |
//! |--------------------|-------|-------------------------------------------------|
//! | flags              | 1     | bit 0: 0 = ckb_hash, 1 = sha256; others zero    |
//! | payment_hash       | 32    | hash of the preimage                            |
//! | receiver_lock_hash | 20    | first 20 bytes of the receiver lock script hash |
//! | refund_lock_hash   | 20    | first 20 bytes of the LSP refund lock hash      |
//! | expiry             | 8     | `since` value (absolute timestamp), LE          |
//! | receiver_capacity  | 8     | shannons owed to the receiver, LE               |

#![no_std]
#![no_main]

use blake2b_ref::Blake2bBuilder;
use ckb_std::{
    ckb_constants::{CellField, InputField, Source},
    default_alloc, entry,
    error::SysError,
    syscalls,
};
use sha2::{Digest, Sha256};

entry!(program_entry);
default_alloc!();

const ARGS_LEN: usize = 89;
const PREIMAGE_LEN: usize = 32;
const UDT_AMOUNT_LEN: usize = 16;

/// Upper bound on what a claim or refund transaction may take out of the cell
/// as transaction fee: 0.01 CKB.
const FEE_CAP: u64 = 1_000_000;

const FLAG_HASH_SHA256: u8 = 0b0000_0001;
const FLAG_RESERVED_MASK: u8 = !FLAG_HASH_SHA256;

/// Top byte of a `since` value that is an absolute, timestamp-based lock.
const SINCE_FLAGS_MASK: u64 = 0xff00_0000_0000_0000;
const SINCE_ABSOLUTE_TIMESTAMP: u64 = 0x4000_0000_0000_0000;
const SINCE_VALUE_MASK: u64 = 0x00ff_ffff_ffff_ffff;

// Molecule layout of `Script` (a table with three fields): a 4-byte total
// size, three 4-byte field offsets, then code_hash (32), hash_type (1) and
// args (4-byte length + bytes).
const SCRIPT_HEADER_LEN: usize = 16;
const SCRIPT_CODE_HASH_OFFSET: usize = SCRIPT_HEADER_LEN;
const SCRIPT_HASH_TYPE_OFFSET: usize = SCRIPT_CODE_HASH_OFFSET + 32;
const SCRIPT_ARGS_OFFSET: usize = SCRIPT_HASH_TYPE_OFFSET + 1;
const OWN_SCRIPT_LEN: usize = SCRIPT_ARGS_OFFSET + 4 + ARGS_LEN;

// Molecule layout of `WitnessArgs` (a table with three optional fields).
const WITNESS_HEADER_LEN: usize = 16;

#[repr(i8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    IndexOutOfBound = 1,
    ItemMissing = 2,
    LengthNotEnough = 3,
    Encoding = 4,
    Syscall = 5,

    ArgsLength = 10,
    ReservedFlags = 11,
    ExtraInputs = 12,
    WitnessLockLength = 13,

    PreimageMismatch = 20,
    ReceiverOutputMissing = 21,
    ReceiverLockMismatch = 22,
    ReceiverCapacityTooLow = 23,
    ReceiverCapacityExceedsCell = 24,
    ChangeOutputMissing = 25,
    ChangeLockMismatch = 26,
    ChangeCapacityTooLow = 27,

    ExpiryNotAbsoluteTimestamp = 30,
    SinceNotAbsoluteTimestamp = 31,
    SinceBeforeExpiry = 32,
    RefundOutputMissing = 33,
    RefundLockMismatch = 34,
    RefundCapacityTooLow = 35,

    OutputTypeMismatch = 40,
    OutputTypeNotAllowed = 41,
    OutputDataNotAllowed = 42,
    UdtDataTooShort = 43,
    UdtAmountTooLow = 44,
}

impl From<SysError> for Error {
    fn from(err: SysError) -> Self {
        match err {
            SysError::IndexOutOfBound => Error::IndexOutOfBound,
            SysError::ItemMissing => Error::ItemMissing,
            SysError::LengthNotEnough(_) => Error::LengthNotEnough,
            SysError::Encoding => Error::Encoding,
            _ => Error::Syscall,
        }
    }
}

struct Args {
    sha256: bool,
    payment_hash: [u8; 32],
    receiver_lock_hash: [u8; 20],
    refund_lock_hash: [u8; 20],
    expiry: u64,
    receiver_capacity: u64,
}

impl Args {
    fn parse(raw: &[u8]) -> Result<Self, Error> {
        if raw.len() != ARGS_LEN {
            return Err(Error::ArgsLength);
        }
        let flags = raw[0];
        if flags & FLAG_RESERVED_MASK != 0 {
            return Err(Error::ReservedFlags);
        }
        let mut payment_hash = [0u8; 32];
        payment_hash.copy_from_slice(&raw[1..33]);
        let mut receiver_lock_hash = [0u8; 20];
        receiver_lock_hash.copy_from_slice(&raw[33..53]);
        let mut refund_lock_hash = [0u8; 20];
        refund_lock_hash.copy_from_slice(&raw[53..73]);
        let mut u = [0u8; 8];
        u.copy_from_slice(&raw[73..81]);
        let expiry = u64::from_le_bytes(u);
        u.copy_from_slice(&raw[81..89]);
        let receiver_capacity = u64::from_le_bytes(u);
        Ok(Args {
            sha256: flags & FLAG_HASH_SHA256 != 0,
            payment_hash,
            receiver_lock_hash,
            refund_lock_hash,
            expiry,
            receiver_capacity,
        })
    }
}

/// What the guarded cell holds, read once from the script group's only input.
struct Guarded {
    capacity: u64,
    /// `Some((type script hash, UDT amount))` when the cell carries a type script.
    udt: Option<([u8; 32], u128)>,
}

pub fn program_entry() -> i8 {
    match run() {
        Ok(()) => 0,
        Err(err) => err as i8,
    }
}

fn run() -> Result<(), Error> {
    let mut script = [0u8; OWN_SCRIPT_LEN];
    match syscalls::load_script(&mut script, 0) {
        Ok(len) if len == OWN_SCRIPT_LEN => {}
        Ok(_) | Err(SysError::LengthNotEnough(_)) => return Err(Error::ArgsLength),
        Err(err) => return Err(err.into()),
    }
    if read_u32(&script, 4) != SCRIPT_CODE_HASH_OFFSET
        || read_u32(&script, 8) != SCRIPT_HASH_TYPE_OFFSET
        || read_u32(&script, 12) != SCRIPT_ARGS_OFFSET
        || read_u32(&script, SCRIPT_ARGS_OFFSET) != ARGS_LEN
    {
        return Err(Error::Encoding);
    }
    let args = Args::parse(&script[SCRIPT_ARGS_OFFSET + 4..])?;

    ensure_only_input()?;
    let guarded = load_guarded()?;

    match load_witness_lock()? {
        None => refund(&args, &guarded),
        Some(preimage) => claim(&args, &guarded, &preimage),
    }
}

/// The guarded cell must be the transaction's only input; see the module
/// documentation for why.
fn ensure_only_input() -> Result<(), Error> {
    let mut raw = [0u8; 8];
    match syscalls::load_input_by_field(&mut raw, 0, 1, Source::Input, InputField::Since) {
        Err(SysError::IndexOutOfBound) => Ok(()),
        Ok(_) | Err(SysError::LengthNotEnough(_)) => Err(Error::ExtraInputs),
        Err(err) => Err(err.into()),
    }
}

fn load_guarded() -> Result<Guarded, Error> {
    let capacity = load_capacity(0, Source::GroupInput)?;
    let udt = match load_type_hash(0, Source::GroupInput)? {
        None => None,
        Some(type_hash) => Some((type_hash, load_udt_amount(0, Source::GroupInput)?)),
    };
    Ok(Guarded { capacity, udt })
}

/// Returns the witness lock of the guarded input: `None` selects the refund
/// path, `Some(preimage)` the claim path.
fn load_witness_lock() -> Result<Option<[u8; PREIMAGE_LEN]>, Error> {
    // Header, then the lock field: a 4-byte length and the preimage. Anything
    // after that (input_type, output_type) is not read.
    let mut buf = [0u8; WITNESS_HEADER_LEN + 4 + PREIMAGE_LEN];
    let loaded = match syscalls::load_witness(&mut buf, 0, 0, Source::GroupInput) {
        Ok(len) => len,
        Err(SysError::LengthNotEnough(_)) => buf.len(),
        Err(SysError::IndexOutOfBound) => 0,
        Err(err) => return Err(err.into()),
    };
    if loaded == 0 {
        return Ok(None);
    }
    if loaded < WITNESS_HEADER_LEN {
        return Err(Error::Encoding);
    }
    let lock_start = read_u32(&buf, 4);
    let lock_end = read_u32(&buf, 8);
    if lock_start != WITNESS_HEADER_LEN || lock_end < lock_start {
        return Err(Error::Encoding);
    }
    match lock_end - lock_start {
        // `None`: the option is absent.
        0 => Ok(None),
        // `Some(bytes)`: a 4-byte length followed by the bytes.
        field_len if field_len >= 4 && loaded >= lock_start + 4 => {
            let bytes_len = read_u32(&buf, lock_start);
            if bytes_len != field_len - 4 {
                return Err(Error::Encoding);
            }
            match bytes_len {
                0 => Ok(None),
                PREIMAGE_LEN if loaded >= lock_start + 4 + PREIMAGE_LEN => {
                    let mut preimage = [0u8; PREIMAGE_LEN];
                    preimage.copy_from_slice(&buf[lock_start + 4..lock_start + 4 + PREIMAGE_LEN]);
                    Ok(Some(preimage))
                }
                PREIMAGE_LEN => Err(Error::Encoding),
                _ => Err(Error::WitnessLockLength),
            }
        }
        _ => Err(Error::Encoding),
    }
}

fn claim(args: &Args, guarded: &Guarded, preimage: &[u8; PREIMAGE_LEN]) -> Result<(), Error> {
    if hash_preimage(args.sha256, preimage) != args.payment_hash {
        return Err(Error::PreimageMismatch);
    }

    let change = guarded
        .capacity
        .checked_sub(args.receiver_capacity)
        .ok_or(Error::ReceiverCapacityExceedsCell)?;

    // Output 0 pays the receiver.
    check_payout(
        0,
        &args.receiver_lock_hash,
        args.receiver_capacity,
        guarded,
        Error::ReceiverOutputMissing,
        Error::ReceiverLockMismatch,
        Error::ReceiverCapacityTooLow,
    )?;

    // Output 1 returns the change to the LSP, unless the change is small
    // enough to be spent entirely as transaction fee. The change is always
    // plain CKB, so it must carry neither a type script nor data: whoever
    // builds the claim must not be able to make the LSP's cell hard to spend.
    if change > FEE_CAP {
        let lock_hash = match load_lock_hash(1, Source::Output) {
            Ok(hash) => hash,
            Err(Error::IndexOutOfBound) => return Err(Error::ChangeOutputMissing),
            Err(err) => return Err(err),
        };
        if lock_hash[..20] != args.refund_lock_hash {
            return Err(Error::ChangeLockMismatch);
        }
        if load_capacity(1, Source::Output)? < change - FEE_CAP {
            return Err(Error::ChangeCapacityTooLow);
        }
        if load_type_hash(1, Source::Output)?.is_some() {
            return Err(Error::OutputTypeNotAllowed);
        }
        if !cell_data_is_empty(1, Source::Output)? {
            return Err(Error::OutputDataNotAllowed);
        }
    }
    Ok(())
}

fn refund(args: &Args, guarded: &Guarded) -> Result<(), Error> {
    if args.expiry & SINCE_FLAGS_MASK != SINCE_ABSOLUTE_TIMESTAMP {
        return Err(Error::ExpiryNotAbsoluteTimestamp);
    }
    let mut raw = [0u8; 8];
    load_exact(
        syscalls::load_input_by_field(&mut raw, 0, 0, Source::GroupInput, InputField::Since),
        8,
    )?;
    let since = u64::from_le_bytes(raw);
    if since & SINCE_FLAGS_MASK != SINCE_ABSOLUTE_TIMESTAMP {
        return Err(Error::SinceNotAbsoluteTimestamp);
    }
    if since & SINCE_VALUE_MASK < args.expiry & SINCE_VALUE_MASK {
        return Err(Error::SinceBeforeExpiry);
    }

    check_payout(
        0,
        &args.refund_lock_hash,
        guarded.capacity.saturating_sub(FEE_CAP),
        guarded,
        Error::RefundOutputMissing,
        Error::RefundLockMismatch,
        Error::RefundCapacityTooLow,
    )
}

/// Checks that output `index` hands the guarded value to `lock_hash`: at least
/// `min_capacity` shannons, and — when the guarded cell is a UDT cell — the
/// same type script with at least the same UDT amount. A plain CKB payout must
/// carry neither a type script nor data, and a UDT payout no data beyond the
/// amount, so nobody can attach something that makes the payee's cell hard to
/// spend.
fn check_payout(
    index: usize,
    lock_hash: &[u8; 20],
    min_capacity: u64,
    guarded: &Guarded,
    missing: Error,
    lock_mismatch: Error,
    capacity_too_low: Error,
) -> Result<(), Error> {
    let output_lock_hash = match load_lock_hash(index, Source::Output) {
        Ok(hash) => hash,
        Err(Error::IndexOutOfBound) => return Err(missing),
        Err(err) => return Err(err),
    };
    if output_lock_hash[..20] != lock_hash[..] {
        return Err(lock_mismatch);
    }
    if load_capacity(index, Source::Output)? < min_capacity {
        return Err(capacity_too_low);
    }

    let output_type_hash = load_type_hash(index, Source::Output)?;
    match guarded.udt {
        None => {
            if output_type_hash.is_some() {
                return Err(Error::OutputTypeNotAllowed);
            }
            if !cell_data_is_empty(index, Source::Output)? {
                return Err(Error::OutputDataNotAllowed);
            }
        }
        Some((type_hash, amount)) => {
            if output_type_hash != Some(type_hash) {
                return Err(Error::OutputTypeMismatch);
            }
            if load_udt_amount(index, Source::Output)? < amount {
                return Err(Error::UdtAmountTooLow);
            }
            // Nothing but the amount: extra data would only be someone
            // else's addition to the payee's cell.
            if cell_data_len_exceeds(index, Source::Output, UDT_AMOUNT_LEN)? {
                return Err(Error::OutputDataNotAllowed);
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------ syscall helpers

/// Accepts a syscall result only if it filled exactly `expected` bytes.
fn load_exact(result: Result<usize, SysError>, expected: usize) -> Result<(), Error> {
    match result {
        Ok(len) if len == expected => Ok(()),
        Ok(_) | Err(SysError::LengthNotEnough(_)) => Err(Error::Encoding),
        Err(err) => Err(err.into()),
    }
}

fn load_capacity(index: usize, source: Source) -> Result<u64, Error> {
    let mut raw = [0u8; 8];
    load_exact(
        syscalls::load_cell_by_field(&mut raw, 0, index, source, CellField::Capacity),
        8,
    )?;
    Ok(u64::from_le_bytes(raw))
}

fn load_lock_hash(index: usize, source: Source) -> Result<[u8; 32], Error> {
    let mut hash = [0u8; 32];
    load_exact(
        syscalls::load_cell_by_field(&mut hash, 0, index, source, CellField::LockHash),
        32,
    )?;
    Ok(hash)
}

fn load_type_hash(index: usize, source: Source) -> Result<Option<[u8; 32]>, Error> {
    let mut hash = [0u8; 32];
    match syscalls::load_cell_by_field(&mut hash, 0, index, source, CellField::TypeHash) {
        Err(SysError::ItemMissing) => Ok(None),
        other => load_exact(other, 32).map(|()| Some(hash)),
    }
}

/// Reads the UDT amount: the first 16 bytes of the cell data, little endian.
fn load_udt_amount(index: usize, source: Source) -> Result<u128, Error> {
    let mut raw = [0u8; UDT_AMOUNT_LEN];
    match syscalls::load_cell_data(&mut raw, 0, index, source) {
        Ok(len) if len < UDT_AMOUNT_LEN => Err(Error::UdtDataTooShort),
        Ok(_) | Err(SysError::LengthNotEnough(_)) => Ok(u128::from_le_bytes(raw)),
        Err(err) => Err(err.into()),
    }
}

fn cell_data_is_empty(index: usize, source: Source) -> Result<bool, Error> {
    let mut probe = [0u8; 1];
    match syscalls::load_cell_data(&mut probe, 0, index, source) {
        Ok(len) => Ok(len == 0),
        Err(SysError::LengthNotEnough(_)) => Ok(false),
        Err(err) => Err(err.into()),
    }
}

fn cell_data_len_exceeds(index: usize, source: Source, max: usize) -> Result<bool, Error> {
    let mut probe = [0u8; 1];
    match syscalls::load_cell_data(&mut probe, max, index, source) {
        Ok(len) => Ok(len > 0),
        Err(SysError::LengthNotEnough(_)) => Ok(true),
        Err(err) => Err(err.into()),
    }
}

fn read_u32(buf: &[u8], offset: usize) -> usize {
    let mut raw = [0u8; 4];
    raw.copy_from_slice(&buf[offset..offset + 4]);
    u32::from_le_bytes(raw) as usize
}

fn hash_preimage(sha256: bool, preimage: &[u8; PREIMAGE_LEN]) -> [u8; 32] {
    let mut out = [0u8; 32];
    if sha256 {
        out.copy_from_slice(&Sha256::digest(preimage));
    } else {
        let mut hasher = Blake2bBuilder::new(32)
            .personal(b"ckb-default-hash")
            .build();
        hasher.update(preimage);
        hasher.finalize(&mut out);
    }
    out
}
