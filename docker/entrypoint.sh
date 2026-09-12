#!/bin/sh
# Virtual display for headed agent browsers, a password-protected noVNC viewer, then Orbit.
set -eu

: "${DISPLAY:=:99}"
export DISPLAY
display_number="${DISPLAY#:}"
display_number="${display_number%%.*}"
# A restarted container keeps /tmp: remove the previous X server's lock and socket, or Xvfb
# refuses to start because the lock's PID now belongs to another process.
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
Xvfb "$DISPLAY" -screen 0 "${ORBIT_SCREEN:-1920x1080x24}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!
tries=0
until [ -S "/tmp/.X11-unix/X${display_number}" ]; do
  tries=$((tries + 1))
  if ! kill -0 "$xvfb_pid" 2>/dev/null || [ "$tries" -gt 100 ]; then
    echo "The virtual display did not start:" >&2
    cat /tmp/xvfb.log >&2
    exit 1
  fi
  sleep 0.1
done
fluxbox >/tmp/fluxbox.log 2>&1 &

# The viewer controls logged-in browsers, so it always requires a password (VNC uses the first 8 characters).
password_file=/tmp/.vnc-password
if [ -n "${VNC_PASSWORD:-}" ]; then
  (umask 077 && printf '%s\n' "$VNC_PASSWORD" >"$password_file")
else
  password_file=/data/.vnc-password
  if [ ! -s "$password_file" ]; then
    (umask 077 && tr -dc 'A-Za-z0-9' </dev/urandom | head -c 8 >"$password_file")
  fi
  echo "noVNC password: docker compose exec orbit cat $password_file"
fi
unset VNC_PASSWORD
x11vnc -display "$DISPLAY" -passwdfile "$password_file" -rfbport 5900 -localhost \
  -forever -shared -noxdamage -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
echo "Agent browsers: http://127.0.0.1:6080/vnc.html (or your published viewer port)"

exec node /app/dist/server/index.js --production
