#!/usr/bin/env bash
# INSTALL THE OFFICIAL GLOBALTRUST RFC 3161 TRUST BUNDLE — Production host, owner-run.
#
#   sudo ./scripts/install-tsa-trust-bundle.sh            # download, verify, install
#   ./scripts/install-tsa-trust-bundle.sh --check         # verify the installed file only
#
# Writes /opt/proovra/app/secrets/tsa/trust-bundle.pem (public certificates
# only — no key), which docker-compose.prod.yml mounts read-only into
# proovra-api at /run/proovra/tsa/trust-bundle.pem (TSA_TRUST_BUNDLE_PATH).
#
# SOURCE AND IDENTITY. Both certificates come from the publisher's repository
# over HTTPS, and NEITHER is trusted because of where it came from:
#   * the root must hash to the GLOBALTRUST 2015 fingerprint below — the same
#     value Certificate Transparency records (crt.sh id 362150600) and the
#     publisher serves at the URL below;
#   * the issuing CA "GLOBALTRUST 2015 QUALIFIED TIMESTAMP 1" must hash to the
#     value below (crt.sh) AND verify under that root.
# The publisher's set also contains TEST CAs ("ECM TEST 2015 …"); only the two
# certificates named here are written. Nothing is taken from a timestamp token.
#
# It never reads or prints a secret. It reads two NON-secret lines of the env
# file (the optional pin and policy allowlist) only to say whether they agree
# with what is installed; it never changes the env file.

set -euo pipefail

ROOT_URL="${TSA_INSTALL_ROOT_URL:-https://www.globaltrust.eu/static/globaltrust-2015.crt}"
SET_URL="${TSA_INSTALL_SET_URL:-https://www.globaltrust.eu/static/all-stamm-cert.p7b}"
ROOT_SHA256="${TSA_INSTALL_ROOT_SHA256:-416b1f9e84e74c1d19b23d8d7191c6ad81246e641601f599132729f507beb3cc}"
ISSUER_SHA256="${TSA_INSTALL_ISSUER_SHA256:-945522340e54b7f2226be9e6272f18d2c3d6eca5a579764518dac7b0e0883fc9}"
DEST_DIR="${TSA_TRUST_DIR:-/opt/proovra/app/secrets/tsa}"
ENV_FILE="${ENV_FILE:-/opt/proovra/app/.env}"
OBSERVED_POLICY="1.2.40.0.36.1.1.8.1"
DEST="${DEST_DIR}/trust-bundle.pem"

die() { echo "ERROR: $*" >&2; exit 1; }
for tool in openssl curl awk; do command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required on this host"; done

fp() { openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'; }

describe_bundle() {
  local file="$1" dir n=0 f
  dir="$(mktemp -d)"
  awk -v d="$dir" '/BEGIN CERTIFICATE/{n++; f=sprintf("%s/c%02d.pem", d, n)} f{print > f} /END CERTIFICATE/{f=""}' "$file"
  for f in "$dir"/c*.pem; do
    [ -f "$f" ] || continue
    n=$((n + 1))
    echo "  [$n] $(openssl x509 -in "$f" -noout -subject | sed 's/^subject=//')"
    echo "      sha256=$(fp "$f")  $(openssl x509 -in "$f" -noout -enddate)"
  done
  rm -rf "$dir"
}

env_value() {
  # One non-secret KEY=VALUE line, without sourcing the file.
  [ -r "$ENV_FILE" ] || { echo ""; return 0; }
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

check_installed() {
  [ -r "$DEST" ] || die "$DEST is missing or unreadable"
  local dir root issuer
  dir="$(mktemp -d)"
  awk -v d="$dir" '/BEGIN CERTIFICATE/{n++; f=sprintf("%s/c%02d.pem", d, n)} f{print > f} /END CERTIFICATE/{f=""}' "$DEST"
  root="" issuer=""
  for f in "$dir"/c*.pem; do
    [ -f "$f" ] || continue
    case "$(fp "$f")" in
      "$ROOT_SHA256") root="$f" ;;
      "$ISSUER_SHA256") issuer="$f" ;;
      *) rm -rf "$dir"; die "$DEST contains a certificate that is not the GLOBALTRUST root or its timestamp CA" ;;
    esac
  done
  [ -n "$root" ] && [ -n "$issuer" ] || { rm -rf "$dir"; die "$DEST must hold exactly the GLOBALTRUST 2015 root and GLOBALTRUST 2015 QUALIFIED TIMESTAMP 1"; }
  openssl verify -x509_strict -CAfile "$root" "$issuer" >/dev/null || { rm -rf "$dir"; die "the timestamp CA does not verify under the root"; }
  rm -rf "$dir"
  echo "Installed bundle $DEST:"
  describe_bundle "$DEST"
  echo "  mode $(stat -c '%a' "$DEST" 2>/dev/null || echo '?')  (the API runs as a non-root user: the file must be world-readable)"

  # The optional pin / allowlist, compared — never changed.
  local pin policies
  pin="$(env_value TSA_TRUST_ANCHOR_SHA256 | tr 'A-F' 'a-f' | tr -d ': ')"
  policies="$(env_value TSA_ACCEPTED_POLICY_OIDS)"
  if [ -z "$pin" ]; then
    echo "TSA_TRUST_ANCHOR_SHA256: not set (optional) — the installed bundle is the trust authority."
  elif printf '%s' ",$pin," | grep -q ",${ROOT_SHA256},"; then
    echo "TSA_TRUST_ANCHOR_SHA256: set and includes the installed root — keep it."
  else
    echo "TSA_TRUST_ANCHOR_SHA256: set but does NOT include the installed root ($ROOT_SHA256); /readyz will report tsa_trust_anchor_pin_mismatch."
    echo "  Fix: set TSA_TRUST_ANCHOR_SHA256=$ROOT_SHA256 in $ENV_FILE, or remove the line (the pin is optional)."
    return 3
  fi
  if [ -z "$policies" ]; then
    echo "TSA_ACCEPTED_POLICY_OIDS: not set (optional) — the signed policy is recorded, not filtered."
  elif printf '%s' ",${policies// /}," | grep -q ",${OBSERVED_POLICY},"; then
    echo "TSA_ACCEPTED_POLICY_OIDS: set and includes the GLOBALTRUST policy ${OBSERVED_POLICY} — keep it."
  else
    echo "TSA_ACCEPTED_POLICY_OIDS: set to '${policies}', which does NOT include the policy GLOBALTRUST tokens carry (${OBSERVED_POLICY}); such tokens would be refused."
    echo "  Fix: add ${OBSERVED_POLICY} to TSA_ACCEPTED_POLICY_OIDS in $ENV_FILE, or remove the line (the allowlist is optional)."
    return 3
  fi
  echo "OK: trust bundle installed and consistent."
}

if [ "${1:-}" = "--check" ]; then
  check_installed
  exit $?
fi
[ $# -eq 0 ] || die "usage: $0 [--check]"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading the GLOBALTRUST 2015 root:  $ROOT_URL"
curl -fsS --max-time 60 -o "$work/root.crt" "$ROOT_URL"
echo "Downloading the GLOBALTRUST CA set:     $SET_URL"
curl -fsS --max-time 60 -o "$work/set.p7b" "$SET_URL"

openssl x509 -in "$work/root.crt" -out "$work/root.pem" 2>/dev/null ||
  openssl x509 -inform DER -in "$work/root.crt" -out "$work/root.pem" ||
  die "the downloaded root is not an X.509 certificate"
got="$(fp "$work/root.pem")"
[ "$got" = "$ROOT_SHA256" ] || die "the downloaded root has SHA-256 $got, not the GLOBALTRUST 2015 root $ROOT_SHA256 — nothing installed"
openssl verify -x509_strict -CAfile "$work/root.pem" "$work/root.pem" >/dev/null || die "the root is not a valid self-signed CA"

openssl pkcs7 -inform DER -in "$work/set.p7b" -print_certs -out "$work/set.pem" 2>/dev/null ||
  openssl pkcs7 -in "$work/set.p7b" -print_certs -out "$work/set.pem" ||
  die "the downloaded CA set is not a PKCS#7 certificate bundle"
mkdir -p "$work/set"
awk -v d="$work/set" '/BEGIN CERTIFICATE/{n++; f=sprintf("%s/c%03d.pem", d, n)} f{print > f} /END CERTIFICATE/{f=""}' "$work/set.pem"
issuer=""
for f in "$work/set"/c*.pem; do
  [ "$(fp "$f")" = "$ISSUER_SHA256" ] && { issuer="$f"; break; }
done
[ -n "$issuer" ] || die "the CA set does not contain GLOBALTRUST 2015 QUALIFIED TIMESTAMP 1 ($ISSUER_SHA256) — nothing installed"
openssl verify -x509_strict -CAfile "$work/root.pem" "$issuer" >/dev/null ||
  die "GLOBALTRUST 2015 QUALIFIED TIMESTAMP 1 does not verify under the root — nothing installed"

cat "$issuer" "$work/root.pem" >"$work/trust-bundle.pem"
install -d -m 0755 "$DEST_DIR"
install -m 0644 "$work/trust-bundle.pem" "$DEST.new"
mv -f "$DEST.new" "$DEST"
echo "Installed $DEST"
check_installed
