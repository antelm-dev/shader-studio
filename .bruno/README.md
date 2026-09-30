# Shadergrove Bruno collection

Open this `.bruno` folder as a collection in [Bruno](https://www.usebruno.com/).
Select the `local` environment, then start Shadergrove with `pnpm dev`.
The default `baseUrl` is `http://localhost:4200`; use
`http://localhost:4000` for `pnpm dev:server` or the default Compose port.

In VS Code, install the **Bruno for VS Code** extension (`bruno-api-client.bruno`).
Click the Bruno icon in the Activity Bar, choose **Open Collection**, and select
the repository's `.bruno` directory (the one containing `bruno.json`). Select
the `local` environment in Bruno's sidebar. This opens the existing collection;
there is no format conversion or import step.

## Run the read-only smoke requests

`01 Smoke` checks readiness, capabilities and a translation catalog. It needs
no account and is safe to run as a folder. From the collection directory:

```powershell
bru run "01 Smoke" --env local
```

The other folders are for individual manual requests. Running the whole
collection will create, copy, publish, unpublish or delete data.

## Sign in and use the library

1. Create an account in the web app and verify its email address. In local
   development, the verification link appears in the server terminal when SMTP
   is not configured.
2. In Bruno's `local` environment, set `email` and `password` as **secret**
   values. Run `02 Account / Sign in`, then `Current session`. Bruno's cookie
   jar should send the session cookie on later requests. Check the request
   headers in Bruno's Timeline if an authenticated request returns 401.
3. Run `03 Library / List shaders` or `Create shader`. Copy an owned shader's
   `id` to the `shaderId` environment variable. Set `expectedRevision` from
   that shader's current `revision` before an update, publish or delete.
   A stale revision should return 409.
4. Set `presetId` from a saved preset before deleting it. Read thumbnail and
   texture requests return 404 until the selected shader has that asset.

The upload examples send the included one-pixel PNG as a **raw file body**.
For a different image, choose it in Bruno's Body tab and change the texture
request's `width` and `height` to that image's actual pixel dimensions.

The collection never stores credentials in the repository. Do not replace the
placeholders in the checked-in environment with real tokens or passwords.

## Explore

`04 Explore` requires `PUBLIC_EXPLORE_ENABLED=1` on the server. Set
`publicationId` from the list response. Publishing requires a verified account,
the current shader revision and rights to the shader and its assets. Cookie
authenticated Explore writes send `Origin: {{baseUrl}}`, which must be a trusted
origin on the server. The copy and unpublish requests change data, so run them
only when intended.

The server's complete generated API reference is at `/api/docs` and its OpenAPI
JSON is at `/api/docs-json`. Better Auth routes are mounted separately from the
Nest OpenAPI document. The collection focuses on common manual workflows; use
the server's existing automated tests for regression coverage.
