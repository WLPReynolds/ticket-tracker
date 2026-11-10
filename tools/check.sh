#!/usr/bin/env bash
# Release check — run before every commit that changes the app:
#   tools/check.sh
# 1. Syntax: node --check on every js/*.js and sw.js (skipped with a warning
#    if node isn't installed).
# 2. Wiring: every js/*.js and css/*.css is loaded by index.html and listed in
#    sw.js; nothing is referenced that doesn't exist; config.js loads first
#    and init.js last; every js file (except init.js) has a line in the load
#    guard at the top of js/init.js.
# 3. Version: APP_VERSION in js/config.js, every ?v= in index.html and
#    VERSION in sw.js all agree.
# Exits non-zero on any failure. Works with macOS's bash 3.2 and Linux.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
bad(){ echo "FAIL: $*"; fail=1; }

# --- 1. Syntax ---------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  for f in js/*.js sw.js; do
    node --check "$f" 2>/tmp/check-$$.txt || { bad "syntax error in $f"; cat /tmp/check-$$.txt; }
  done
  rm -f /tmp/check-$$.txt
else
  echo "WARN: node not installed — syntax check skipped"
fi

# --- 2. Wiring ---------------------------------------------------------------
loaded_js=$(grep -o '<script src="js/[^"?]*\.js' index.html | sed 's#<script src="js/##')
loaded_css=$(grep -o '<link rel="stylesheet" href="css/[^"?]*\.css' index.html | sed 's#.*href="css/##')

for f in js/*.js; do
  n=${f#js/}
  echo "$loaded_js" | grep -qx "$n" || bad "$f exists but index.html doesn't load it"
  grep -q "'./js/$n' + V" sw.js || bad "$f isn't in sw.js ASSETS"
  if [ "$n" != "init.js" ]; then
    grep -q "^ *'$n': *typeof " js/init.js || bad "$f has no line in the load guard in js/init.js"
  fi
done
for n in $loaded_js; do [ -f "js/$n" ] || bad "index.html loads js/$n, which doesn't exist"; done
for n in $(grep -o "'./js/[^']*'" sw.js | sed "s#'./js/##; s#'##"); do
  [ -f "js/$n" ] || bad "sw.js lists js/$n, which doesn't exist"
done
for f in css/*.css; do
  n=${f#css/}
  echo "$loaded_css" | grep -qx "$n" || bad "$f exists but index.html doesn't load it"
  grep -q "'./css/$n' + V" sw.js || bad "$f isn't in sw.js ASSETS"
done
for n in $loaded_css; do [ -f "css/$n" ] || bad "index.html loads css/$n, which doesn't exist"; done
for n in $(grep -o "'./css/[^']*'" sw.js | sed "s#'./css/##; s#'##"); do
  [ -f "css/$n" ] || bad "sw.js lists css/$n, which doesn't exist"
done
dupes=$(echo "$loaded_js" | sort | uniq -d)
[ -z "$dupes" ] || bad "index.html loads these more than once: $dupes"
[ "$(echo "$loaded_js" | head -1)" = "config.js" ] || bad "config.js must be the first script in index.html"
[ "$(echo "$loaded_js" | tail -1)" = "init.js" ] || bad "init.js must be the last script in index.html"

# --- 3. Version --------------------------------------------------------------
app_version=$(grep -o "^const APP_VERSION = '[^']*'" js/config.js | sed "s/.*= '//; s/'//")
sw_version=$(grep -o "^const VERSION = '[^']*'" sw.js | sed "s/.*= '//; s/'//")
url_versions=$(grep -o '?v=[0-9][^"]*' index.html | sed 's/?v=//' | sort -u)
want=$(echo "$app_version" | sed 's/^v//; s/://')
[ -n "$app_version" ] || bad "couldn't find APP_VERSION in js/config.js"
[ "$(echo "$url_versions" | wc -l | tr -d ' ')" = "1" ] || bad "index.html has more than one ?v= value: $(echo $url_versions)"
[ "$url_versions" = "$want" ] || bad "index.html ?v=$url_versions doesn't match APP_VERSION $app_version"
[ "$sw_version" = "$want" ] || bad "sw.js VERSION $sw_version doesn't match APP_VERSION $app_version"

if [ $fail -eq 0 ]; then
  echo "OK — $(echo "$loaded_js" | wc -l | tr -d ' ') scripts wired, version $app_version everywhere."
fi
exit $fail
