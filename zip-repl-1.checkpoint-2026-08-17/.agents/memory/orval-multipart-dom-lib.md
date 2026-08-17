---
name: Orval multipart schemas need DOM lib
description: Fix for TS errors on generated Orval client/Zod code when an OpenAPI schema has a `format: binary` (file upload) field.
---

## Rule
If an OpenAPI schema includes a `type: string, format: binary` field (file upload) and the generated client/Zod package's `tsconfig.json` only targets a non-DOM lib (e.g. `es2022`), typecheck fails because the generated code references `File`/`Blob`. Add `"dom"` to that package's `compilerOptions.lib` array.

**Why:** Orval emits `File | Blob` types directly for binary form fields; those types only exist under the DOM lib, not under Node-only or bare ES target libs.

**How to apply:** Whenever a new multipart/file-upload endpoint is added to the OpenAPI spec, check the codegen output package's tsconfig `lib` array includes `"dom"` before assuming a typecheck failure is a real bug.
