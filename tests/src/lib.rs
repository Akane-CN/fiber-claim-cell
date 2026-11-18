//! Script-level tests for async-claim-lock.
//!
//! Every test builds a transaction and runs it through the real CKB script
//! verifier (ckb-testtool), so a pass here means the RISC-V binary accepted or
//! rejected the transaction exactly as a node would.

#![cfg(test)]

use blake2b_ref::Blake2bBuilder;
use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    bytes::Bytes,
    ckb_error::Error as CkbError,
    ckb_types::{
        core::{ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellInput, CellOutput, OutPoint, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use sha2::{Digest, Sha256};

const MAX_CYCLES: u64 = 10_000_000;
const CKB: u64 = 100_000_000;
const FEE_CAP: u64 = 1_000_000;

const SINCE_ABSOLUTE_TIMESTAMP: u64 = 0x4000_0000_0000_0000;
const SINCE_RELATIVE_TIMESTAMP: u64 = 0xc000_0000_0000_0000;
const EXPIRY_SECONDS: u64 = 1_800_000_000;

// Error codes, mirroring contracts/async-claim-lock/src/main.rs.
const ERR_ARGS_LENGTH: i8 = 10;
const ERR_RESERVED_FLAGS: i8 = 11;
const ERR_EXTRA_INPUTS: i8 = 12;
const ERR_WITNESS_LOCK_LENGTH: i8 = 13;
const ERR_PREIMAGE_MISMATCH: i8 = 20;
const ERR_RECEIVER_OUTPUT_MISSING: i8 = 21;
const ERR_RECEIVER_LOCK_MISMATCH: i8 = 22;
const ERR_RECEIVER_CAPACITY_TOO_LOW: i8 = 23;
const ERR_RECEIVER_CAPACITY_EXCEEDS_CELL: i8 = 24;
const ERR_CHANGE_OUTPUT_MISSING: i8 = 25;
const ERR_CHANGE_LOCK_MISMATCH: i8 = 26;
const ERR_CHANGE_CAPACITY_TOO_LOW: i8 = 27;
const ERR_EXPIRY_NOT_ABSOLUTE_TIMESTAMP: i8 = 30;
const ERR_SINCE_NOT_ABSOLUTE_TIMESTAMP: i8 = 31;
const ERR_SINCE_BEFORE_EXPIRY: i8 = 32;
const ERR_REFUND_OUTPUT_MISSING: i8 = 33;
const ERR_REFUND_LOCK_MISMATCH: i8 = 34;
const ERR_REFUND_CAPACITY_TOO_LOW: i8 = 35;
const ERR_OUTPUT_TYPE_MISMATCH: i8 = 40;
const ERR_OUTPUT_TYPE_NOT_ALLOWED: i8 = 41;
const ERR_OUTPUT_DATA_NOT_ALLOWED: i8 = 42;
const ERR_UDT_AMOUNT_TOO_LOW: i8 = 44;

fn ckb_hash(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut hasher = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(data);
    hasher.finalize(&mut out);
    out
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(data));
    out
}

fn lock_hash20(script: &Script) -> [u8; 20] {
    let mut out = [0u8; 20];
    out.copy_from_slice(&script.calc_script_hash().as_slice()[..20]);
    out
}

/// The fixed cast of every test: the deployed lock, a receiver, an LSP, a
/// stranger, and two stand-in UDT type scripts.
struct Env {
    context: Context,
    claim_lock_out_point: OutPoint,
    receiver_lock: Script,
    refund_lock: Script,
    stranger_lock: Script,
    udt_type: Script,
    other_udt_type: Script,
}

impl Env {
    fn new() -> Self {
        let mut context = Context::default();
        let binary: Bytes = std::fs::read("../build/release/async-claim-lock")
            .expect("run `make build` first")
            .into();
        let claim_lock_out_point = context.deploy_cell(binary);
        let always_success = context.deploy_cell(ALWAYS_SUCCESS.clone());
        let mut named = |name: &'static [u8]| {
            context
                .build_script_with_hash_type(
                    &always_success,
                    ScriptHashType::Data1,
                    Bytes::from_static(name),
                )
                .unwrap()
        };
        let receiver_lock = named(b"receiver");
        let refund_lock = named(b"lsp-refund");
        let stranger_lock = named(b"stranger");
        let udt_type = named(b"udt");
        let other_udt_type = named(b"other-udt");
        Env {
            context,
            claim_lock_out_point,
            receiver_lock,
            refund_lock,
            stranger_lock,
            udt_type,
            other_udt_type,
        }
    }

    fn claim_lock(&mut self, args: Vec<u8>) -> Script {
        self.context
            .build_script_with_hash_type(
                &self.claim_lock_out_point,
                ScriptHashType::Data2,
                args.into(),
            )
            .unwrap()
    }

    fn args(
        &self,
        flags: u8,
        payment_hash: [u8; 32],
        expiry: u64,
        receiver_capacity: u64,
    ) -> Vec<u8> {
        let mut args = Vec::with_capacity(89);
        args.push(flags);
        args.extend_from_slice(&payment_hash);
        args.extend_from_slice(&lock_hash20(&self.receiver_lock));
        args.extend_from_slice(&lock_hash20(&self.refund_lock));
        args.extend_from_slice(&expiry.to_le_bytes());
        args.extend_from_slice(&receiver_capacity.to_le_bytes());
        args
    }

    /// Creates a live claim cell and returns its out point.
    fn claim_cell(
        &mut self,
        args: Vec<u8>,
        capacity: u64,
        udt: Option<(Script, u128)>,
    ) -> OutPoint {
        let lock = self.claim_lock(args);
        let (type_, data) = match udt {
            None => (None, Bytes::new()),
            Some((type_, amount)) => (Some(type_), Bytes::from(amount.to_le_bytes().to_vec())),
        };
        let cell = CellOutput::new_builder()
            .capacity(capacity)
            .lock(lock)
            .type_(type_.pack())
            .build();
        self.context.create_cell(cell, data)
    }

    fn verify(&mut self, tx: TransactionView) -> Result<u64, CkbError> {
        let tx = self.context.complete_tx(tx);
        self.context.verify_tx(&tx, MAX_CYCLES)
    }
}

fn output(lock: &Script, capacity: u64) -> (CellOutput, Bytes) {
    (
        CellOutput::new_builder()
            .capacity(capacity)
            .lock(lock.clone())
            .build(),
        Bytes::new(),
    )
}

fn udt_output(lock: &Script, capacity: u64, type_: &Script, amount: u128) -> (CellOutput, Bytes) {
    (
        CellOutput::new_builder()
            .capacity(capacity)
            .lock(lock.clone())
            .type_(Some(type_.clone()).pack())
            .build(),
        Bytes::from(amount.to_le_bytes().to_vec()),
    )
}

fn witness_with_lock(lock: &[u8]) -> Bytes {
    WitnessArgs::new_builder()
        .lock(Some(Bytes::from(lock.to_vec())).pack())
        .build()
        .as_bytes()
}

/// Builds a transaction spending `inputs` (each with its `since`) into
/// `outputs`, with one witness per input.
fn build_tx(
    inputs: Vec<(OutPoint, u64)>,
    witnesses: Vec<Bytes>,
    outputs: Vec<(CellOutput, Bytes)>,
) -> TransactionView {
    let mut builder = TransactionBuilder::default();
    for (out_point, since) in inputs {
        builder = builder.input(CellInput::new(out_point, since));
    }
    for witness in witnesses {
        builder = builder.witness(witness.pack());
    }
    for (cell, data) in outputs {
        builder = builder.output(cell).output_data(data.pack());
    }
    builder.build()
}

fn claim_tx(cell: OutPoint, preimage: &[u8], outputs: Vec<(CellOutput, Bytes)>) -> TransactionView {
    build_tx(vec![(cell, 0)], vec![witness_with_lock(preimage)], outputs)
}

fn refund_tx(cell: OutPoint, since: u64, outputs: Vec<(CellOutput, Bytes)>) -> TransactionView {
    build_tx(vec![(cell, since)], vec![Bytes::new()], outputs)
}

fn assert_script_error(result: Result<u64, CkbError>, code: i8) {
    let err = result.expect_err("transaction should have been rejected");
    let message = err.to_string();
    assert!(
        message.contains(&format!("error code {} ", code)),
        "expected script error {code}, got: {message}"
    );
}

const PREIMAGE: [u8; 32] = [7u8; 32];
const EXPIRY: u64 = SINCE_ABSOLUTE_TIMESTAMP | EXPIRY_SECONDS;

// ---------------------------------------------------------------- claim, CKB

#[test]
fn claim_pays_receiver_and_returns_change() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB + 1000, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
        ],
    );
    let cycles = env.verify(tx).expect("claim should pass");
    println!("claim (ckb_hash, with change) cycles: {cycles}");
}

#[test]
fn claim_with_sha256_and_no_change_output() {
    let mut env = Env::new();
    let args = env.args(1, sha256(&PREIMAGE), EXPIRY, 200 * CKB);
    // Change is 1000 shannons, below FEE_CAP: it may be spent as fee.
    let cell = env.claim_cell(args, 200 * CKB + 1000, None);
    let tx = claim_tx(cell, &PREIMAGE, vec![output(&env.receiver_lock, 200 * CKB)]);
    let cycles = env.verify(tx).expect("claim should pass");
    println!("claim (sha256, no change) cycles: {cycles}");
}

#[test]
fn claim_allows_extra_outputs() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB + 1000, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
            output(&env.stranger_lock, 500),
        ],
    );
    // The stranger's output is not a valid cell on a real chain; the point is
    // only that the script does not look past outputs 0 and 1.
    env.verify(tx).expect("extra outputs are not the script's business");
}

#[test]
fn claim_rejects_any_other_input() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    // Even a harmless-looking fee sponsor is refused: the script cannot tell
    // it apart from a cell whose own lock wants the same outputs.
    let sponsor_cell = output(&env.stranger_lock, 500 * CKB).0;
    let sponsor = env.context.create_cell(sponsor_cell, Bytes::new());
    for inputs in [vec![(cell.clone(), 0), (sponsor.clone(), 0)], vec![(sponsor, 0), (cell, 0)]] {
        let witnesses = inputs.iter().map(|_| witness_with_lock(&PREIMAGE)).collect();
        let tx = build_tx(
            inputs,
            witnesses,
            vec![
                output(&env.receiver_lock, 100 * CKB),
                output(&env.refund_lock, 61 * CKB),
                output(&env.stranger_lock, 499 * CKB),
            ],
        );
        assert_script_error(env.verify(tx), ERR_EXTRA_INPUTS);
    }
}

#[test]
fn claim_rejects_sharing_an_output_with_the_payees_own_cell() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 100 * CKB, None);
    // The receiver already owns a 100 CKB cell under a lock that, like
    // anyone-can-pay, is satisfied by "an output pays me at least as much".
    // One 100 CKB output would satisfy that lock and this one together, and
    // the other 100 CKB would be free for the taking.
    let own_cell = output(&env.receiver_lock, 100 * CKB).0;
    let own = env.context.create_cell(own_cell, Bytes::new());
    let tx = build_tx(
        vec![(cell, 0), (own, 0)],
        vec![witness_with_lock(&PREIMAGE), Bytes::new()],
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.stranger_lock, 100 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_EXTRA_INPUTS);
}

#[test]
fn rejects_sharing_outputs_with_another_version_of_the_script() {
    let mut env = Env::new();
    // The same code referenced another way stands in for an upgraded
    // deployment: a different script identity with the same payout rules.
    let other_preimage = [9u8; 32];
    let args_a = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let args_b = env.args(0, ckb_hash(&other_preimage), EXPIRY, 100 * CKB);
    let cell_a = env.claim_cell(args_a, 161 * CKB, None);
    let other_version = env
        .context
        .build_script_with_hash_type(&env.claim_lock_out_point.clone(), ScriptHashType::Data1, args_b.into())
        .unwrap();
    let cell_b = env.context.create_cell(output(&other_version, 161 * CKB).0, Bytes::new());
    let claim = build_tx(
        vec![(cell_a.clone(), 0), (cell_b.clone(), 0)],
        vec![witness_with_lock(&PREIMAGE), witness_with_lock(&other_preimage)],
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
            output(&env.stranger_lock, 161 * CKB),
        ],
    );
    assert_script_error(env.verify(claim), ERR_EXTRA_INPUTS);
    let refund = build_tx(
        vec![(cell_a, EXPIRY), (cell_b, EXPIRY)],
        vec![Bytes::new(), Bytes::new()],
        vec![
            output(&env.refund_lock, 161 * CKB),
            output(&env.stranger_lock, 161 * CKB),
        ],
    );
    assert_script_error(env.verify(refund), ERR_EXTRA_INPUTS);
}

#[test]
fn claim_rejects_type_script_or_data_on_the_change_output() {
    let mut env = Env::new();
    let udt = env.udt_type.clone();
    for (index, change) in [
        udt_output(&env.refund_lock, 61 * CKB, &udt, 0),
        (output(&env.refund_lock, 61 * CKB).0, Bytes::from_static(b"x")),
    ]
    .into_iter()
    .enumerate()
    {
        let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
        let cell = env.claim_cell(args, 161 * CKB, None);
        let tx = claim_tx(cell, &PREIMAGE, vec![output(&env.receiver_lock, 100 * CKB), change]);
        let expected = if index == 0 { ERR_OUTPUT_TYPE_NOT_ALLOWED } else { ERR_OUTPUT_DATA_NOT_ALLOWED };
        assert_script_error(env.verify(tx), expected);
    }
    // The change of a UDT claim is plain CKB too.
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 142 * CKB);
    let cell = env.claim_cell(args, 211 * CKB, Some((udt.clone(), UDT_AMOUNT)));
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            udt_output(&env.receiver_lock, 142 * CKB, &udt, UDT_AMOUNT),
            udt_output(&env.refund_lock, 69 * CKB, &udt, 0),
        ],
    );
    assert_script_error(env.verify(tx), ERR_OUTPUT_TYPE_NOT_ALLOWED);
}

#[test]
fn udt_payout_rejects_data_beyond_the_amount() {
    let mut env = Env::new();
    let udt = env.udt_type.clone();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 142 * CKB);
    let cell = env.claim_cell(args, 211 * CKB, Some((udt.clone(), UDT_AMOUNT)));
    let (payout, data) = udt_output(&env.receiver_lock, 142 * CKB, &udt, UDT_AMOUNT);
    let mut padded = data.to_vec();
    padded.push(0);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![(payout, padded.into()), output(&env.refund_lock, 69 * CKB)],
    );
    assert_script_error(env.verify(tx), ERR_OUTPUT_DATA_NOT_ALLOWED);
}

#[test]
fn claim_rejects_wrong_preimage() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(
        cell,
        &[8u8; 32],
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_PREIMAGE_MISMATCH);
}

#[test]
fn claim_rejects_preimage_hashed_with_the_other_algorithm() {
    let mut env = Env::new();
    // args say sha256, but the hash was produced with ckb_hash.
    let args = env.args(1, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_PREIMAGE_MISMATCH);
}

#[test]
fn claim_rejects_payout_to_someone_else() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.stranger_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_RECEIVER_LOCK_MISMATCH);
}

#[test]
fn claim_rejects_receiver_output_in_wrong_position() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.refund_lock, 61 * CKB),
            output(&env.receiver_lock, 100 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_RECEIVER_LOCK_MISMATCH);
}

#[test]
fn claim_rejects_no_outputs() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(cell, &PREIMAGE, vec![]);
    assert_script_error(env.verify(tx), ERR_RECEIVER_OUTPUT_MISSING);
}

#[test]
fn claim_rejects_underpaying_receiver() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB - 1),
            output(&env.refund_lock, 61 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_RECEIVER_CAPACITY_TOO_LOW);
}

#[test]
fn claim_rejects_cell_smaller_than_receiver_capacity() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 200 * CKB);
    let cell = env.claim_cell(args, 150 * CKB, None);
    let tx = claim_tx(cell, &PREIMAGE, vec![output(&env.receiver_lock, 150 * CKB)]);
    assert_script_error(env.verify(tx), ERR_RECEIVER_CAPACITY_EXCEEDS_CELL);
}

#[test]
fn claim_rejects_missing_change_output() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    // The claimer tries to keep the LSP's 61 CKB change as "fee".
    let tx = claim_tx(cell, &PREIMAGE, vec![output(&env.receiver_lock, 100 * CKB)]);
    assert_script_error(env.verify(tx), ERR_CHANGE_OUTPUT_MISSING);
}

#[test]
fn claim_rejects_change_to_someone_else() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.stranger_lock, 61 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_CHANGE_LOCK_MISMATCH);
}

#[test]
fn claim_rejects_change_short_by_more_than_fee_cap() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 162 * CKB, None);
    let exact = 62 * CKB - FEE_CAP;
    let ok = claim_tx(
        cell.clone(),
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, exact),
        ],
    );
    env.verify(ok)
        .expect("change short by exactly FEE_CAP is allowed");
    let short = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, exact - 1),
        ],
    );
    assert_script_error(env.verify(short), ERR_CHANGE_CAPACITY_TOO_LOW);
}

#[test]
fn claim_rejects_type_script_on_ckb_payout() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 300 * CKB);
    let cell = env.claim_cell(args, 300 * CKB, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![udt_output(&env.receiver_lock, 300 * CKB, &env.udt_type, 0)],
    );
    assert_script_error(env.verify(tx), ERR_OUTPUT_TYPE_NOT_ALLOWED);
}

#[test]
fn claim_rejects_data_on_ckb_payout() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 300 * CKB);
    let cell = env.claim_cell(args, 300 * CKB, None);
    let mut payout = output(&env.receiver_lock, 300 * CKB);
    payout.1 = Bytes::from_static(b"junk");
    let tx = claim_tx(cell, &PREIMAGE, vec![payout]);
    assert_script_error(env.verify(tx), ERR_OUTPUT_DATA_NOT_ALLOWED);
}

#[test]
fn claim_rejects_two_claim_cells_in_one_transaction() {
    let mut env = Env::new();
    // Two different payments to the same receiver. Without the only-input
    // rule one 100 CKB output would satisfy both.
    let other_preimage = [9u8; 32];
    let args_a = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let args_b = env.args(0, ckb_hash(&other_preimage), EXPIRY, 100 * CKB);
    let cell_a = env.claim_cell(args_a, 100 * CKB, None);
    let cell_b = env.claim_cell(args_b, 100 * CKB, None);
    let tx = build_tx(
        vec![(cell_a, 0), (cell_b, 0)],
        vec![
            witness_with_lock(&PREIMAGE),
            witness_with_lock(&other_preimage),
        ],
        vec![output(&env.receiver_lock, 100 * CKB)],
    );
    assert_script_error(env.verify(tx), ERR_EXTRA_INPUTS);
}

#[test]
fn rejects_witness_lock_of_wrong_length() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = claim_tx(
        cell,
        &PREIMAGE[..31],
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_WITNESS_LOCK_LENGTH);
}

#[test]
fn rejects_malformed_args() {
    let mut env = Env::new();
    let mut short = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    short.pop();
    let cell = env.claim_cell(short, 161 * CKB, None);
    let tx = claim_tx(cell, &PREIMAGE, vec![output(&env.receiver_lock, 161 * CKB)]);
    assert_script_error(env.verify(tx), ERR_ARGS_LENGTH);

    let reserved = env.args(0b10, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(reserved, 161 * CKB, None);
    let tx = claim_tx(cell, &PREIMAGE, vec![output(&env.receiver_lock, 161 * CKB)]);
    assert_script_error(env.verify(tx), ERR_RESERVED_FLAGS);
}

// --------------------------------------------------------------- refund, CKB

#[test]
fn refund_after_expiry_pays_lsp() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = refund_tx(
        cell.clone(),
        EXPIRY,
        vec![output(&env.refund_lock, 161 * CKB - FEE_CAP)],
    );
    let cycles = env.verify(tx).expect("refund at expiry should pass");
    println!("refund cycles: {cycles}");

    let later = refund_tx(
        cell,
        EXPIRY + 3600,
        vec![output(&env.refund_lock, 161 * CKB - 1000)],
    );
    env.verify(later).expect("refund after expiry should pass");
}

#[test]
fn refund_rejects_since_before_expiry() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = refund_tx(cell, EXPIRY - 1, vec![output(&env.refund_lock, 161 * CKB)]);
    assert_script_error(env.verify(tx), ERR_SINCE_BEFORE_EXPIRY);
}

#[test]
fn refund_rejects_since_of_another_kind() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    for since in [
        0,                                         // no lock at all
        EXPIRY_SECONDS * 2,                        // absolute block number
        SINCE_RELATIVE_TIMESTAMP | EXPIRY_SECONDS, // relative timestamp
        0x2000_0000_0000_0000 | EXPIRY_SECONDS,    // absolute epoch
    ] {
        let tx = refund_tx(
            cell.clone(),
            since,
            vec![output(&env.refund_lock, 161 * CKB)],
        );
        assert_script_error(env.verify(tx), ERR_SINCE_NOT_ABSOLUTE_TIMESTAMP);
    }
}

#[test]
fn refund_rejects_expiry_that_is_not_an_absolute_timestamp() {
    let mut env = Env::new();
    // expiry encoded as a bare number: the cell can still be claimed, but
    // never refunded.
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY_SECONDS, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = refund_tx(
        cell.clone(),
        EXPIRY,
        vec![output(&env.refund_lock, 161 * CKB)],
    );
    assert_script_error(env.verify(tx), ERR_EXPIRY_NOT_ABSOLUTE_TIMESTAMP);

    let claim = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 100 * CKB),
            output(&env.refund_lock, 61 * CKB),
        ],
    );
    env.verify(claim)
        .expect("claim is unaffected by a bad expiry");
}

#[test]
fn refund_rejects_payout_to_someone_else() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let to_stranger = refund_tx(
        cell.clone(),
        EXPIRY,
        vec![output(&env.stranger_lock, 161 * CKB)],
    );
    assert_script_error(env.verify(to_stranger), ERR_REFUND_LOCK_MISMATCH);

    // The receiver cannot use the refund path either.
    let to_receiver = refund_tx(
        cell.clone(),
        EXPIRY,
        vec![output(&env.receiver_lock, 161 * CKB)],
    );
    assert_script_error(env.verify(to_receiver), ERR_REFUND_LOCK_MISMATCH);

    let nothing = refund_tx(cell, EXPIRY, vec![]);
    assert_script_error(env.verify(nothing), ERR_REFUND_OUTPUT_MISSING);
}

#[test]
fn refund_rejects_skimming_more_than_fee_cap() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 100 * CKB);
    let cell = env.claim_cell(args, 161 * CKB, None);
    let tx = refund_tx(
        cell,
        EXPIRY,
        vec![output(&env.refund_lock, 161 * CKB - FEE_CAP - 1)],
    );
    assert_script_error(env.verify(tx), ERR_REFUND_CAPACITY_TOO_LOW);
}

// ----------------------------------------------------------------------- UDT

const UDT_AMOUNT: u128 = 25_000_000;

#[test]
fn udt_claim_pays_receiver_and_returns_change() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 142 * CKB);
    let udt = env.udt_type.clone();
    let cell = env.claim_cell(args, 211 * CKB + 1000, Some((udt.clone(), UDT_AMOUNT)));
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            udt_output(&env.receiver_lock, 142 * CKB, &udt, UDT_AMOUNT),
            output(&env.refund_lock, 69 * CKB),
        ],
    );
    let cycles = env.verify(tx).expect("UDT claim should pass");
    println!("UDT claim cycles: {cycles}");
}

#[test]
fn udt_claim_rejects_lower_amount() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 142 * CKB);
    let udt = env.udt_type.clone();
    let cell = env.claim_cell(args, 211 * CKB, Some((udt.clone(), UDT_AMOUNT)));
    let tx = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            udt_output(&env.receiver_lock, 142 * CKB, &udt, UDT_AMOUNT - 1),
            output(&env.refund_lock, 69 * CKB),
        ],
    );
    assert_script_error(env.verify(tx), ERR_UDT_AMOUNT_TOO_LOW);
}

#[test]
fn udt_claim_rejects_other_or_missing_type_script() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 142 * CKB);
    let udt = env.udt_type.clone();
    let other = env.other_udt_type.clone();
    let cell = env.claim_cell(args, 211 * CKB, Some((udt, UDT_AMOUNT)));

    let wrong_token = claim_tx(
        cell.clone(),
        &PREIMAGE,
        vec![
            udt_output(&env.receiver_lock, 142 * CKB, &other, UDT_AMOUNT),
            output(&env.refund_lock, 69 * CKB),
        ],
    );
    assert_script_error(env.verify(wrong_token), ERR_OUTPUT_TYPE_MISMATCH);

    let no_token = claim_tx(
        cell,
        &PREIMAGE,
        vec![
            output(&env.receiver_lock, 142 * CKB),
            output(&env.refund_lock, 69 * CKB),
        ],
    );
    assert_script_error(env.verify(no_token), ERR_OUTPUT_TYPE_MISMATCH);
}

#[test]
fn udt_refund_returns_tokens_to_lsp() {
    let mut env = Env::new();
    let args = env.args(0, ckb_hash(&PREIMAGE), EXPIRY, 142 * CKB);
    let udt = env.udt_type.clone();
    let cell = env.claim_cell(args, 211 * CKB, Some((udt.clone(), UDT_AMOUNT)));

    let ok = refund_tx(
        cell.clone(),
        EXPIRY,
        vec![udt_output(&env.refund_lock, 211 * CKB - 1000, &udt, UDT_AMOUNT)],
    );
    env.verify(ok).expect("UDT refund should pass");

    let tokens_dropped = refund_tx(
        cell.clone(),
        EXPIRY,
        vec![output(&env.refund_lock, 211 * CKB - 1000)],
    );
    assert_script_error(env.verify(tokens_dropped), ERR_OUTPUT_TYPE_MISMATCH);

    let tokens_short = refund_tx(
        cell,
        EXPIRY,
        vec![udt_output(&env.refund_lock, 211 * CKB - 1000, &udt, UDT_AMOUNT - 1)],
    );
    assert_script_error(env.verify(tokens_short), ERR_UDT_AMOUNT_TOO_LOW);
}
