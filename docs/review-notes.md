# Internal review notes

These notes list what one round of adversarial review each of the lock script and of the LSP-side code found, and what was done about every item. The reviews were done inside the project and are not a substitute for a third-party audit.

Every item marked "Fixed" has a matching test in the current code. Every item marked "Open" is also listed under the open items of RFC 0001.

## Lock script

| Finding | Severity | Outcome |
| --- | --- | --- |
| **One output could satisfy several scripts.** The earlier version only forbade a second input with the same code. The same binary referenced in another way, or a later version of it, is a different script identity, so two claim cells could go into one transaction and share output 0, with the surplus going to whoever built the transaction. An anyone-can-pay style cell belonging to the receiver or the LSP could share an output with a claim cell in the same way. The first case was reproduced in a test | High, conditional | Fixed. The claim cell must be the transaction's only input. The script was redeployed for this and the old deployment is void |
| **The change output was unconstrained.** Output 1 of a claim transaction was checked only for lock and capacity. Whoever built the transaction could add a type script or data to it and make the LSP's change hard to spend, or lock it for good | Medium | Fixed. Output 1 must have no type script and empty data |
| **A UDT payout could carry extra data** | Informational | Fixed. The data must be exactly 16 bytes |
| **A claim cell with a type script but under 16 bytes of data can never be spent; a cell whose `expiry` is not an absolute timestamp can never be refunded** | Low, self-inflicted by the LSP | Script unchanged. The chain cannot stop anyone creating a bad cell. The LSP's construction code and the receiver's verification code guard against it |
| **With change between `FEE_CAP` and 61 CKB, a receiver with no CKB cannot claim** | Low | The receiver rejects such a cell when verifying it, and the LSP's construction code never produces one |
| **Whoever submits the transaction can keep a difference of up to `FEE_CAP`** | Informational | By design. The cap is 0.01 CKB |

Properties the review confirmed: the witness is read at the claim cell's own position; `since` is read only from the claim cell's input and every other encoding is rejected; capacity arithmetic cannot overflow; a refund cannot be split across outputs; args of the wrong length are always rejected.

## LSP-side module

| Finding | Severity | Outcome |
| --- | --- | --- |
| **A claim with a non-canonical witness was not recognised.** The script reads only the first 52 bytes of the witness, while the LSP read the preimage with a strict parser. A receiver who appended one byte to the witness left the LSP unable ever to read the preimage: it had paid out and would not settle upstream | Critical | Fixed. The preimage is taken byte for byte the way the script reads it, with unit tests |
| **Path A and path B could both pay.** A receiver who submitted a path A invoice while the LSP was creating the claim cell was paid on both | Critical | Fixed. Only one caller may handle a given payment at a time, and the state is rechecked before paying |
| **Path A did not check the invoice's hash algorithm.** With the same hash under another algorithm, the LSP paid and got a preimage it could not settle upstream with | Critical | Fixed. The algorithm is checked, and after a payment over the channel succeeds the preimage is verified before settling |
| **Path A accepted UDT invoices and did not cap routing fees** | High | Fixed. UDT invoices are refused, and the routing fee is capped at the difference between the incoming and outgoing amounts |
| **Path A did not check the payee node.** Anyone holding the token and the preimage could have the LSP pay any node | High | Fixed. Only the node recorded at registration is paid. A receiver with no registered node uses path B only |
| **After sending a refund, the chain was no longer consulted.** If the receiver's claim confirmed first and the node stopped reporting the refund transaction's status, the payment stayed in "refunding" for ever and the LSP did not settle | High | Fixed. Every pass checks which transaction actually spent the claim cell |
| **The lower bound on the incoming expiry did not hold.** It started from "first saw the payment", which is late after a stall or a restart | High | Fixed. It now starts from "last saw the invoice still unpaid", which can only be early |
| **A creation transaction the node reported as rejected was replaced with a new one.** The original could still confirm through another node, leaving two claim cells for one payment | Medium to high | Fixed. The signed transaction is written to disk before it is broadcast, and the same one is resent after a restart. It is abandoned only once one of its inputs has been spent on chain |
| **Before paying, the incoming invoice was not checked to be still held** | Medium | Fixed |
| **The incoming TLC was failed back after one refund confirmation.** A reorg could turn the refund into a claim | Medium to low | Fixed. The TLC is failed back only after the refund has the configured number of confirmations (default 6) |
| **No exposure cap** | Medium | Fixed. A total cap and a per-receiver cap can be set. Over the cap, a payment waits, and is returned to the payer if the wait runs out |
| **The public interface was unlimited.** Unlimited registrations and invoice requests could drain a receiver's hash pool | High | Partly fixed. Request body size, hashes per call and per receiver, and unpaid invoices per receiver are limited, and registering again can no longer add hashes. Rate limiting by source is left to the operator |
| **The transaction creating a claim cell is slow to confirm** | Medium | Open |
| **No alert for stuck states** | Low | Open |

## Receiver and receive page

| Finding | Severity | Outcome |
| --- | --- | --- |
| **Seed, preimages and token were not scoped to an LSP, and the page accepted LSP and node addresses from the URL.** A link to the genuine page could make it take the seed to an attacker's server. The same wallet registering the same hashes with two LSPs let a preimage revealed at one be used to settle at the other | High | Fixed. Preimages and token are derived from the LSP's node public key, and a production build does not read addresses from the URL |
| **The page used the lock script and safety parameters the LSP reported.** An LSP could name a backdoored script, or set confirmations and margin to zero | High, with a malicious LSP | Fixed. On public networks the page uses its built-in code hash, and confirmations and margin have built-in floors |
| **A claim transaction was not tracked after broadcast.** If it dropped out of the pool, the preimage was already public, the cell expired and was refunded, and the LSP could settle and keep the full amount | Medium to high | Fixed. The page stores the claim transaction and resends it when it is neither in the pool nor confirmed |
| **A cell that passed verification might still be unclaimable.** There was no check that the capacity paid to the receiver is enough to form a cell, that the change is enough to form a cell, or that a fee is left over, and only the local clock was used | Low | Fixed. The clock is the later of local time and the latest block's timestamp |
| **The receiver cannot check the amount.** The amount comes from the LSP, which can understate it | Medium, protocol level | Open |
| **The signed message is not bound to the site's origin** | Medium | Open. The message text carries a warning |
| **The signature string is not normalised, and wallets with non-deterministic signatures are not detected** | Low | Open |
