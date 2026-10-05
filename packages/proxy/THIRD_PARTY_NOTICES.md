# Third-party notices

## SerenityJS

Portions of this package are derived from or based on [SerenityJS](https://github.com/SerenityJS/serenity), licensed under the MIT License.
The upstream revision is `eb6ac9734aeae0d3f4ac441c222804e1af6a6b4d` (`@serenityjs/protocol` 0.8.21).

- `src/protocol/start-game.ts`: adapted from [StartGamePacket](https://github.com/SerenityJS/serenity/blob/eb6ac9734aeae0d3f4ac441c222804e1af6a6b4d/packages/protocol/src/proto/data/start-game.ts). Only the prefix through `dimension` is retained; imports, field types, and formatting were adjusted.
- `src/proxy.ts`: lifecycle observations based on [LoginHandler](https://github.com/SerenityJS/serenity/blob/eb6ac9734aeae0d3f4ac441c222804e1af6a6b4d/packages/core/src/handlers/login.ts) and [SetLocalPlayerAsInitializedHandler](https://github.com/SerenityJS/serenity/blob/eb6ac9734aeae0d3f4ac441c222804e1af6a6b4d/packages/core/src/handlers/set-local-player-as-initialized.ts). Adapted for proxy-side observation, verification, and Player notifications rather than server-side world/entity creation.
- `test/lifecycle.test.ts`: the serialized StartGame fixture is derived from the SerenityJS protocol definition.

The following upstream notice applies to those portions, including their copies in the compiled output and source maps. It does not replace this project's [LICENSE](LICENSE).

```text
MIT License

Copyright (c) 2024 SerenityJS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
