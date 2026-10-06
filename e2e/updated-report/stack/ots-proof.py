"""
Build an OpenTimestamps proof for one digest, offline, with the official
`opentimestamps` library shipped in the worker image.

The proof has the shape a real calendar upgrade produces: the digest is
embedded in a serialized Bitcoin transaction (an OP_RETURN output), the
transaction is double-SHA256 hashed into its txid, and a Bitcoin block-header
attestation sits on that (a one-transaction block, so the merkle root IS the
txid). `ots info` therefore reports the transaction id and the block height,
exactly as for a real proof. The transaction and block are synthetic — there is
no Bitcoin node or network here — so the product records the anchor as
PROOF_STRUCTURE ("anchored, not checked against the Bitcoin chain"), never as
chain-verified.

Usage: python ots-proof.py <sha256-hex>   → base64 proof on stdout
"""
import base64
import io
import sys

from opentimestamps.core.notary import BitcoinBlockHeaderAttestation
from opentimestamps.core.op import OpAppend, OpPrepend, OpSHA256
from opentimestamps.core.serialize import StreamSerializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

digest = bytes.fromhex(sys.argv[1])
assert len(digest) == 32

# version | 1 input (non-coinbase prevout, empty scriptSig, final sequence)
# | 1 output (value 0, OP_RETURN PUSH32 <digest>) | locktime
prefix = bytes.fromhex(
    "01000000"            # version
    "01"                  # input count
    + "11" * 32           # prevout txid
    + "00000000"          # prevout index
    + "00"                # scriptSig length
    + "ffffffff"          # sequence
    + "01"                # output count
    + "0000000000000000"  # value
    + "22"                # script length (34)
    + "6a20"              # OP_RETURN, push 32 bytes
)
suffix = bytes.fromhex("00000000")  # locktime

root = Timestamp(digest)
tx = root.ops.add(OpPrepend(prefix)).ops.add(OpAppend(suffix))
txid = tx.ops.add(OpSHA256()).ops.add(OpSHA256())
txid.attestations.add(BitcoinBlockHeaderAttestation(840000))

buf = io.BytesIO()
DetachedTimestampFile(OpSHA256(), root).serialize(StreamSerializationContext(buf))
sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
