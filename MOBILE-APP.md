# Bonsai Rehab Center — Mobile App (Android + iOS)

The website is now wrapped in a **Capacitor** native app. One codebase, two platforms:

- **Android** — built on this PC, delivered as `.apk` files in `mobile/dist/`.
- **iOS** — the Xcode project is generated (`mobile/ios/`); final `.ipa` must be built on a Mac.

## Quick start — install the APK

The finished phone installer is:

```
mobile/dist/BonsaiRehab-release-1.0.apk
```

Install on any Android phone by opening that file (allow "install from unknown sources" if asked). The app is a signed release build.

> Important: the app talks to the backend server over the internet. It shows the
> home page offline, but every feature (login, appointments, assessments,
> gait lab) needs the deployed server from the next section.

## 1. Deploy the backend to Render (required)

The app needs the Express API running somewhere public. Render is the fastest route:

1. Push this `brc-website` folder to a GitHub repo.
2. In Render → **New → Blueprint**, paste your repo URL.
3. Render reads `render.yaml`: it builds the Docker image (Node + Python + ffmpeg
   for the Gait Lab), mounts a persistent disk at `/data` (your SQLite DB and
   uploaded videos live there so they survive redeploys), and generates a random
   `JWT_SECRET`.
4. Wait for the deploy, then note your URL, e.g. `https://bonsai-rehab-server.onrender.com`.

Alternatively use Render's **Web Service** pointing at the same repo with these values:

| Setting        | Value                                            |
|----------------|--------------------------------------------------|
| Environment    | Docker                                           |
| Dockerfile     | `./Dockerfile`                                   |
| Plan           | Standard (2 GB disk minimum)                     |
| Env `JWT_SECRET` | long random string                           |
| Env `PERSIST_DIR` | `/data`                                      |
| Disk (mount)   | `/data` (1–2 GB)                                 |

### 2. Point the app at your server

One value controls it — edit `public/js/mobile.js`:

```js
var API_BASE = 'https://bonsai-rehab-server.onrender.com'; // your deployed URL
```

Then rebuild the app (section 3) or, if the Android project is already synced,
just rerun `npx cap sync android` and the Gradle build.

> To test against your own PC instead of a host: run `npm start`, put the PC's
> LAN IP in `API_BASE` (e.g. `http://192.168.1.10:3000`), keep the phone on the
> same Wi‑Fi, and in `capacitor.config.json` keep `"cleartext": true`
> (already set) so the app may use http for testing.

## 3. Building the APKs yourself (this PC)

Prerequisites already installed here: JDK 21 (`C:\Users\Muhammad Mehr Ali\jdk-21`)
and the Android SDK (`C:\Android\sdk`).

```powershell
cd mobile
npx cap sync android                       # copies public/ into the Android project
cd android
.\gradlew.bat assembleDebug                # -> app/build/outputs/apk/debug
.\gradlew.bat assembleRelease              # -> app/build/outputs/apk/release
```

Release builds are signed with the keystore in `mobile/keystore/`.

## 4. Keystore — keep this safe (do not lose it)

- Keystore file: `mobile/keystore/brc-release.keystore`
- Credentials: `mobile/keystore/keystore.properties` (also ignored by git)

If you lose the keystore you cannot release an **update** to this same app ID —
Android will treat it as a different app. Back these two files up somewhere safe.

## 5. iOS build (needs a Mac)

On a Mac with Xcode:

```bash
cd mobile
npm install
npx cap sync ios
npx cap open ios
```

Then in Xcode: set your **Team** under *Signing & Capabilities*, bump the bundle
identifier version if needed, and press *Run* (device) or *Archive* → *Distribute*
to produce the `.ipa`. Building an IPA also requires an Apple Developer account
($99/year) and, to ship outside the App Store, a registered UDID for each tester.

## 6. How the app works under the hood

- `public/js/mobile.js` (loaded on every page) detects the Capacitor shell, stores
  the login JWT in `@capacitor/preferences`, and rewrites every `fetch('/api/…')`
  to the remote server with an `Authorization: Bearer` header — no cookie/CORS issues.
- `routes/auth.js` now also accepts the JWT from the `Authorization` header, and
  returns the token in the login/signup JSON bodies. The desktop website is
  unchanged (still cookie-based).
- `server.js` enables CORS for the app origins and symlinks `db/` + `uploads/`
  onto the Render disk when `PERSIST_DIR` is set.

## 7. Files changed / added for the mobile build

```
server.js                       # CORS + Bearer-friendly + PERSIST_DIR
routes/auth.js                  # Bearer support; token in login/signup response
public/js/mobile.js             # NEW: in-app bridge
Dockerfile                      # Render image (Node + Python gait engine)
requirements.txt                # Python deps for gait analysis
render.yaml                     # Render blueprint (disk, env, service)
.env.example                    # sample env vars
mobile/                         # Capacitor project
  ├─ capacitor.config.json
  ├─ android/                   # Android native project
  ├─ ios/                       # Xcode project
  ├─ keystore/                  # signing keys (gitignored)
  ├─ dist/                      # built APKs (gitignored)
```