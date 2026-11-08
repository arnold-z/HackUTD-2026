#!/bin/sh
# Signs the packaged app. With a stable certificate ("FocusGuard Dev" by default), macOS keeps
# Screen Recording / Accessibility / Automation permissions across rebuilds. Without one it falls
# back to an ad-hoc signature, which macOS treats as a new app on every build.
APP=$(ls -d release/FocusGuard-darwin-*/FocusGuard.app | head -1)
ID="${FOCUSGUARD_SIGN_ID:-FocusGuard Dev}"
if security find-certificate -c "$ID" >/dev/null 2>&1; then
  codesign --force --deep --sign "$ID" "$APP" && echo "Signed with \"$ID\" (permissions will persist across rebuilds)" && exit 0
  echo "Signing with \"$ID\" failed; falling back to ad-hoc."
else
  echo "No \"$ID\" certificate found; signing ad-hoc. Permissions will reset on each rebuild (see README)."
fi
codesign --force --deep --sign - "$APP"
