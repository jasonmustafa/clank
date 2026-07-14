#!/bin/sh
set -eu
# Run as root after `npm run build`; install system helper first to provide pinned Node.
test -x /usr/local/lib/clank/node/bin/node
install -d -o root -g root -m 0755 /usr/local/lib/clank
install -o root -g root -m 0755 dist/helpers/github-helper-entrypoint.js /usr/local/lib/clank/github-helper
install -o root -g root -m 0644 dist/helpers/github-helper.js dist/helpers/github-protocol.js /usr/local/lib/clank/
install -o root -g root -m 0440 setup/github-helper/clank-github-helper.sudoers /etc/sudoers.d/clank-github-helper
visudo -cf /etc/sudoers.d/clank-github-helper
