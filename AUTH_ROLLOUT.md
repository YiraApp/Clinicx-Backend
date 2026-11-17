# Retiring header-based login

Released mobile builds identify themselves with `userId` + `deviceId` (headers, query or body) and no token check. The backend still accepts this until `ALLOW_LEGACY_USER_HEADERS=false` is set.

## Order

1. **Deploy the web app first.** Staff pages now send their token to `/api/hospitals`, `/api/providers` and similar routes. The backend change below requires it, so an older web build would get 401 on those pages.
2. **Deploy the backend.** Leave `ALLOW_LEGACY_USER_HEADERS` unset. Released mobile builds keep working.
3. **Release the new mobile build.** It sends the access token on every API call.
4. **Watch the logs.** `[Auth] Legacy identity used` lines show requests still using the old path.
5. **Force the update** to the new mobile build using the app-version check.
6. **Set `ALLOW_LEGACY_USER_HEADERS=false`** once those log lines stop, then restart. Setting it back and restarting undoes this.

Do not set the flag before step 5: released builds would lose workspace, menu and profile calls.

## After the flag is off

- A claimed `x-user-id` only changes the acting user for an account in the caller's family.
- `/v1/api/auth/user-data` returns 403 for anyone outside the caller's family.
- The `x-user-id` and `x-device-id` headers can then be removed from the mobile app.
