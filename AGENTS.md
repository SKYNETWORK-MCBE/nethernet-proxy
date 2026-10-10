## リリース

### バージョンを上げる

各packageでバージョンは統一する仕様

1. package.jsonのバージョンを変更
2. `update: vx.y.z` のようにコミットする
3. `git tag vx.y.z` でタグを作成
4. (pushまで指示された場合) `git push origin main --tags` でpush
