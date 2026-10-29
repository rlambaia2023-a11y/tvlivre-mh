@echo off
cd /d "C:\Users\FBBR\Downloads\tvlivreMH-extracted\tvlivreMH"
git init
git config user.email "rlambaia2023-a11y@users.noreply.github.com"
git config user.name "rlambaia2023-a11y"
git add .
git commit -m "feat: tvlivremh - TV local com canais abertos (Globo, SBT, Record, Band, Cultura e mais 455)"
echo COMMIT_OK
