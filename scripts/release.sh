#!/usr/bin/env bash
set -Eeuo pipefail

# VallenEmperor release helper: bump version + publish to npm.
#
#   ./scripts/release.sh patch                 # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor --otp=123456    # kode 2FA dari authenticator
#   NPM_TOKEN=... ./scripts/release.sh patch   # granular token (bypass 2FA)
#
# Token dibaca dari (urutan prioritas): environment NPM_TOKEN, lalu file .env
# (baris NPM_TOKEN=...). Nilai token tidak pernah dicetak dan tidak ditulis ke
# config npm. Akun dengan 2FA wajib memakai --otp=<kode> atau token granular
# yang "bypass 2FA"-nya aktif, kalau tidak npm menolak dengan E403.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

LEVEL="${1:-patch}"
shift || true
case "$LEVEL" in
  patch|minor|major) ;;
  -h|--help)
    sed -n '4,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Usage: ./scripts/release.sh [patch|minor|major] [opsi npm publish, mis. --otp=123456]" >&2
    exit 1
    ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  echo '✖ Working tree tidak bersih. Commit dulu (./update.sh) sebelum rilis supaya versi yang terbit bisa dilacak.' >&2
  exit 1
fi

echo '[1/4] Menjalankan test...'
npm test

echo "[2/4] Menaikkan versi ($LEVEL)..."
npm version "$LEVEL" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
echo "      versi baru: $VERSION"

echo '[3/4] Publish ke npm...'
NPM_TOKEN="${NPM_TOKEN:-}"
if [[ -z "$NPM_TOKEN" && -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      NPM_TOKEN=*|export\ NPM_TOKEN=*) NPM_TOKEN="${line#*=}" ;;
    esac
  done < .env
  NPM_TOKEN="${NPM_TOKEN%\"}"; NPM_TOKEN="${NPM_TOKEN#\"}"
  NPM_TOKEN="${NPM_TOKEN%\'}"; NPM_TOKEN="${NPM_TOKEN#\'}"
  NPM_TOKEN="${NPM_TOKEN//[[:space:]]/}"
  [[ -n "$NPM_TOKEN" ]] && echo '      token npm dimuat dari .env (nilai disembunyikan).'
fi

if [[ -n "$NPM_TOKEN" ]]; then
  npm publish --//registry.npmjs.org/:_authToken="$NPM_TOKEN" "$@"
else
  echo '      Tidak ada NPM_TOKEN; npm akan meminta OTP kalau akun mewajibkan 2FA.'
  npm publish "$@"
fi

echo '[4/4] Selesai.'
echo "✔ vallenemperor@$VERSION terbit di npm."
echo "  Commit kenaikan versi: ./update.sh"
echo "  Cek hasil: npm view vallenemperor version && npm install -g vallenemperor"
