# ascii-cam

リアルタイムでWebカメラ映像をASCIIアート化するシングルファイルデモ。
自分や猫の動きに合わせてASCIIが変化するインタラクティブ体験を目的としている。

## アーキテクチャ

- **シングルHTML構成**（`ascii-cam.html`）— ビルド不要、`open ascii-cam.html` で即動作
- フレームワーク・依存パッケージなし、Vanilla JS のみ
- Google Fonts（Share Tech Mono）のみ外部参照

## 描画の仕組み

1. `getUserMedia` でカメラストリームを取得
2. 非表示の `<canvas>` にフレームを描画（`scaleX(-1)` で鏡像化）
3. `getImageData` でピクセル輝度をサンプリング
4. 輝度を70段階の文字セット（`$@B%8&WM#*...`）にマッピング
5. `<pre>` 相当の `<div>` にテキストとして出力（`requestAnimationFrame` ループ）
6. アスペクト比補正係数 `0.48`（モノスペースフォントの縦横比に合わせる）

## レイヤー構造

```
#stage（position: relative）
├── #ascii-output（ベースレイヤー）
└── #video-overlay（position: absolute, inset: 0）
```

`#video-overlay` は `object-fit: fill` でASCIIと完全一致させている。
`object-fit: cover` にするとアスペクト比のズレが生じるので注意。

## UI コントロール

| コントロール        | 変数                  | 備考                        |
| ------------------- | --------------------- | --------------------------- |
| RES スライダー      | `cols` 60〜200        | 文字密度。上げるとFPS低下   |
| CONTRAST スライダー | `contrastVal` 0.5〜3  | エッジの際立ち              |
| OVERLAY スライダー  | `overlayOpacity` 0〜1 | 生映像の透明度              |
| INVERT ボタン       | `inverted`            | 白黒反転                    |
| SCREEN ボタン       | `blendIndex`          | ブレンドモード5種をサイクル |

### ブレンドモード（順番）

`screen` → `lighten` → `hard-light` → `overlay` → `normal`

OVERLAY 50% + SCREEN の組み合わせが最も効果的。

## ライセンス

CC BY-NC 4.0 — Hideki Akiba @ tuqulore  
個人・非商用のみ許可。クレジット表記必須。
