#!/bin/sh
set -eu

# Run as root after `npm run build`. The helper and runtime must never be writable by clank.
install -d -o root -g root -m 0755 /usr/local/lib/clank /usr/local/lib/clank/node/bin
install -o root -g root -m 0755 "$1" /usr/local/lib/clank/node/bin/node
install -o root -g root -m 0755 dist/helpers/system-helper-entrypoint.js /usr/local/lib/clank/system-helper
install -o root -g root -m 0644 dist/helpers/system-helper.js dist/helpers/system-protocol.js /usr/local/lib/clank/
install -d -o root -g clank -m 0750 /srv/clank/logs
if [ ! -e /srv/clank/logs/helper-audit.log ]; then
  install -o root -g clank -m 0640 /dev/null /srv/clank/logs/helper-audit.log
fi
install -o root -g root -m 0440 setup/system-helper/clank-system-helper.sudoers /etc/sudoers.d/clank-system-helper
visudo -cf /etc/sudoers.d/clank-system-helper
install -o root -g root -m 0644 setup/system-helper/clank-helper-audit.logrotate /etc/logrotate.d/clank-helper-audit
