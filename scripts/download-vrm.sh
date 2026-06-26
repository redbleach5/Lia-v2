#!/bin/bash
# Download sample VRM model for 3D avatar.
#
# If this fails (network), the app will automatically fall back to 2D SVG avatar.

set -e

MODEL_DIR="public/models"
MODEL_FILE="$MODEL_DIR/sample.vrm"
URL="https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_FILE" ]; then
  echo "VRM model already exists: $MODEL_FILE"
  exit 0
fi

echo "Downloading sample VRM model from Pixiv three-vrm repo..."
echo "URL: $URL"
echo "Size: ~10 MB"

if curl -sL "$URL" -o "$MODEL_FILE"; then
  SIZE=$(stat -c%s "$MODEL_FILE" 2>/dev/null || stat -f%z "$MODEL_FILE")
  if [ "$SIZE" -gt 1000000 ]; then
    echo "✓ Downloaded $MODEL_FILE ($((SIZE / 1024 / 1024)) MB)"
    echo ""
    echo "To use a custom VRM model:"
    echo "  1. Create one at https://vroid.com/en/studio (free)"
    echo "  2. Save as public/models/Lia.vrm"
    echo "  3. Edit DEFAULT_VRM_SRC in src/components/lia/vrm-avatar.tsx"
  else
    echo "✗ Downloaded file too small ($SIZE bytes) — probably an error page"
    rm -f "$MODEL_FILE"
    exit 1
  fi
else
  echo "✗ Download failed. The app will use 2D SVG avatar as fallback."
  exit 1
fi
