#!/usr/bin/env bash
# Run this from Terminal on your Mac:
#   cd ~/Desktop/BM/Portfolio\ Companies/bmv-portfolio-site && bash launch.sh
set -e
cd "$(dirname "$0")"

echo "==> clearing stale git locks"
rm -f .git/index.lock .git/HEAD.lock .git/refs/heads/main.lock .git/objects/maintenance.lock 2>/dev/null || true
rm -rf .git/_stale 2>/dev/null || true
find .git/objects -name 'tmp_obj_*' -delete 2>/dev/null || true

echo "==> pushing to GitHub"
git push -u origin main

echo
echo "Pushed. Next:"
echo "  Preview locally :  npx serve ."
echo "  Deploy          :  vercel.com > Add New > Project > import Portfolio-Management"
echo "                     Framework: Other.  Build command: none.  Output dir: ./"
