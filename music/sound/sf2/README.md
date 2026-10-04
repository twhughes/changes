# SoundFonts for the FluidSynth driver

`fluid.py` loads the first `*.sf2` it finds here (after `$MUSIC_SF2`, before the
system dirs). The `.sf2` files themselves are gitignored (`music/sound/sf2/*.sf2`)
— this README records where to get them.

## GeneralUser-GS.sf2 (default)

- **Source:** https://github.com/mrbumpy409/GeneralUser-GS/raw/main/GeneralUser-GS.sf2
- **Project home:** https://www.schristiancollins.com/generaluser.php
- **Version:** GeneralUser GS v2.0.3 (License v2.0)
- **Size:** ~32 MB
- **License:** Free for private and commercial music creation, redistribution,
  and modification (permissive custom license — see the repo's
  `documentation/LICENSE.txt`). One courtesy request: link to the project home,
  not directly to the author's download files.
- **Electric-piano program (bank 0):**
  - **program 4 — "Tine Electric Piano"** (Rhodes-style — the driver picks this)
  - program 5 — "FM Electric Piano"
  - program 0 — "Grand Piano" (final fallback)

To fetch it:

```sh
curl -L -o music/sound/sf2/GeneralUser-GS.sf2 \
  https://github.com/mrbumpy409/GeneralUser-GS/raw/main/GeneralUser-GS.sf2
```

Or point `$MUSIC_SF2` at any other `.sf2` to override.
