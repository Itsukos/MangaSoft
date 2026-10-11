# AniList

AniList is used in two ways. Metadata lookups work without an account. Progress tracking needs you to connect one.

## Connecting your account

1. Go to <https://anilist.co/settings/developer> and choose **Create New Client**.
2. For the redirect URL use the address you open MangaSoft on, followed by `/auth.html`. For example
   `http://localhost:8484/auth.html` or `http://192.168.1.20:8484/auth.html`. Use the same address you will be on
   while connecting.
3. Copy the client **ID**. It is a number. You do not need the secret.
4. In MangaSoft open **Settings, AniList**, paste the ID and press **Connect**.

## What it does

- In the manga reader, **Mark chapter N read on AniList** (or the `M` key) updates your list. There is an option to
  do it automatically when you finish a chapter.
- In the anime player, progress is marked at 90 percent of an episode, or with the button. There is an option to do
  it automatically.
- Progress only moves forward. Reaching the last chapter or episode marks the entry as Completed.
- The **Social** page shows what your AniList friends have been watching and reading, and lets you like activity and
  add things to your lists.

## Matching

Series are matched by title, with the format taken into account (manga, anime, novel). If a match is wrong, open the
series and use **Match on AniList** or **Fix metadata** to pick the right entry.
