# Create an empty repository on GitHub (no README, no .gitignore) named "venira-mcp-coding"
# under the owner you have push access to, then run:

cd G:\venira\venira-mcp-coding-standalone

# 1. Point git at the new repo (replace with your actual URL):
git remote add origin https://github.com/YOUR_USERNAME/venira-mcp-coding.git

# 2. Push (this is a fresh repo, so it's a clean push):
git push -u origin main

# 3. On GitHub, enable Actions (Settings -> Actions -> General)
#    and add the repo to the Renovate app so it picks up renovate.json.
