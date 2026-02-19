#!/bin/bash
set -e

echo ""
echo "  Datacore Installer"
echo "  ==================="
echo ""

MIN_NODE=20

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
else
    echo "Unsupported OS: $OSTYPE"
    echo "Please install manually: npm install -g @datacore-one/cli"
    exit 1
fi

# Get current Node major version (0 if not installed)
get_node_major() {
    if command -v node &> /dev/null; then
        node --version | sed 's/v//' | cut -d. -f1
    else
        echo "0"
    fi
}

current_node=$(get_node_major)

if [ "$current_node" -ge "$MIN_NODE" ] 2>/dev/null; then
    echo "  Node.js v$(node --version | sed 's/v//') ... ok"
else
    if [ "$current_node" -eq "0" ]; then
        echo "  Node.js not found. Installing..."
    else
        echo "  Node.js v$(node --version | sed 's/v//') is too old (need v${MIN_NODE}+). Upgrading..."
    fi
    echo ""

    if [ "$OS" = "macos" ]; then
        if command -v brew &> /dev/null; then
            echo "  Installing Node.js via Homebrew..."
            brew install node 2>/dev/null || brew upgrade node 2>/dev/null || true
        else
            echo "  Installing Homebrew first..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            echo "  Installing Node.js via Homebrew..."
            brew install node
        fi
    elif [ "$OS" = "linux" ]; then
        if command -v npm &> /dev/null; then
            echo "  Installing Node.js LTS via n (node version manager)..."
            sudo npm install -g n 2>/dev/null
            sudo n lts
            # Refresh shell hash so new node is found
            hash -r 2>/dev/null || true
        else
            echo "  Installing Node.js LTS via NodeSource..."
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
            sudo apt-get install -y nodejs
        fi
    fi

    # Verify
    current_node=$(get_node_major)
    if [ "$current_node" -lt "$MIN_NODE" ] 2>/dev/null; then
        echo ""
        echo "  Node.js upgrade failed. Please install Node.js ${MIN_NODE}+ manually:"
        echo "    https://nodejs.org/"
        echo ""
        echo "  Then re-run this script."
        exit 1
    fi

    echo "  Node.js v$(node --version | sed 's/v//') ... ok"
fi

echo ""
echo "  Installing @datacore-one/cli..."
echo ""

if [ "$OS" = "linux" ]; then
    sudo npm install -g @datacore-one/cli@latest
else
    npm install -g @datacore-one/cli@latest
fi

echo ""
echo "  Done! Run 'datacore init' to get started."
echo ""
