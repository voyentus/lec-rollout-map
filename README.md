# Deployment Strategy System

A signed-in web map for planning the LEC meter rollout: household and transformer
locations, mobile coverage, and shared gateway planning layers.

This repository holds only the app's code. All data lives in a Supabase database
and is loaded after sign-in; accounts are created by the project owner.

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `feeder01.js`: the Feeder 01 map, a second view behind the switch in the top bar that shows
  a household CSV opened on the user's computer (the file is never uploaded)
- `config.js`: the Supabase project address and its publishable key
