# 为抖铲铲编写的网页端仿抖音图文播放器

为“抖铲铲下载统计报告”播放器编写的独立网页端图文/视频播放器。项目经过多次迭代和打磨，做出了较为良好的核心交互体验。

## 功能

- 图片、视频混合播放，支持同组媒体循环浏览
- 左右切换媒体、上下切换作品组
- 键盘方向键、鼠标肩键、按钮点击统一交互反馈
- 图片自动播放进度线与媒体序号提示
- 视频自然结束后自动进入下一媒体；视频 → 图片使用溶解过渡
- 图片缩放、拖拽、回到初始位置
- 图片缩放后默认关闭自动播放；缩放 ≤ 150% 时可单击图片重新开/关自动播放
- 单媒体组自动隐藏左右切换与自动播放开关
- MP3 背景音乐、音量控制、按钮内无缝滚动“正在播放：音乐名”
- 作品作者、日期、标题与 `#标签` 高亮
- 全屏模式
- 可选虚化背景：图片使用当前图；视频使用第一帧静止背景，并跟随媒体切换动画

## 项目结构

```text
.
├── index.html              # 独立演示页
├── src/
│   ├── player.css          # 从 v18 抽离的播放器样式
│   ├── player.js           # 从 v18 抽离并独立化的播放器逻辑
│   └── demo-data.js        # 隐私安全的演示数据
├── assets/
│   ├── demo-image-*.svg    # 演示图片
│   ├── demo-video.mp4      # 演示视频
│   └── demo-music.mp3      # 演示音乐
├── LICENSE
└── .gitignore
```

## 本地运行

最简单的方法是在项目根目录启动一个静态 HTTP 服务：

```bash
python -m http.server 8000
```

然后打开：

```text
http://localhost:8000
```

直接双击 `index.html` 通常也能使用，但不同浏览器对 `file://` 本地媒体、自动播放与全屏策略的限制不同，推荐使用本地 HTTP 服务。

## 数据格式

播放器读取 `window.DCC_PLAYER_ITEMS`。每个作品组至少可以提供：

```js
window.DCC_PLAYER_ITEMS = [
  {
    title: "作品标题 #标签",
    author: "作者名",
    create_time: 1784736000, // Unix 秒时间戳
    filenames: [
      "media/01.jpg",
      "media/01.mp4",
      "media/01.mp3"
    ]
  }
];
```

支持的主要媒体类型：

- 图片：JPG / JPEG / PNG / GIF / WebP / AVIF / BMP / SVG
- 视频：MP4 / WebM / OGV / MOV / M4V
- 音频：MP3 / WAV / M4A / AAC / FLAC / Opus / OGG

媒体路径既可以是相对路径，也可以是 HTTP(S)、Blob、Data URL。

## 基本调用

先加载数据，再加载播放器：

```html
<script src="src/my-data.js"></script>
<script src="src/player.js"></script>
```

打开指定作品组：

```js
DCCPlayer.open(0);
```

关闭播放器：

```js
DCCPlayer.close();
```

运行时替换数据：

```js
DCCPlayer.setItems(newItems);
```

## 与抖铲铲统计报告集成

抖铲铲统计报告中的数据结构本身已经包含 `title`、`author`、`create_time`、`filenames` 等字段，因此可以直接将目标作品组数组传给播放器。

此仓库刻意不附带任何真实统计报告或下载媒体，避免把私人下载历史、作者清单和本地文件名提交到公共代码仓库。

## 浏览器说明

- 推荐最新版 Chromium / Chrome / Edge。
- 未经用户交互的有声视频或 MP3 自动播放可能被浏览器策略阻止，这是浏览器行为；点击播放按钮后可正常继续。
- 视频虚化背景使用独立视频副本停留在首帧，不依赖 Canvas 导出，因此更适合本地媒体场景。

## License

MIT License。详见 [LICENSE](LICENSE)。
