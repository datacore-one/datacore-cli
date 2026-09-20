# A deliberately bare machine: node and git, nothing else Datacore needs.
#
# The point is to catch "it works because my laptop already had it". No brew,
# no gh auth, no ~/Data, no global npm packages, no Claude Code.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*

# A non-root user with a real HOME: the installer writes to ~/Data and
# ~/.datacore, and running as root hides permission problems real users hit.
RUN useradd -m -s /bin/bash tester

# The LOCAL build, not the published package — we are testing this working
# tree. The global install runs as ROOT because the npm prefix is root-owned;
# doing it after USER tester fails with EACCES, which is a property of the
# image, not of the installer under test.
COPY pkg/ /opt/datacore-cli/
RUN cd /opt/datacore-cli && npm install -g . --omit=dev

# Everything the installer itself does happens as an ordinary user.
USER tester
WORKDIR /home/tester

# Give the test user a WRITABLE npm prefix, which is what nvm/fnm/Homebrew
# users have and what the documented Linux path achieves with sudo. Without
# it every `npm install -g` the installer runs dies on EACCES and the test
# only ever re-proves that /usr/local is root-owned — it never reaches the
# install logic under test. The EACCES path has its own assertion below.
ENV NPM_CONFIG_PREFIX=/home/tester/.npm-global
ENV PATH=/home/tester/.npm-global/bin:$PATH
RUN mkdir -p /home/tester/.npm-global

COPY interactive-init.py /home/tester/interactive-init.py

CMD ["bash"]
