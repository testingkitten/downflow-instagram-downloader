# Cosmos-Inspired HTML5 Video Player

Reusable architecture, interaction rules, visual tokens, accessibility requirements, and implementation guidance for the quiet media player used in the Instagram Downloader.

## 1. Purpose

This document is a portable design and engineering specification. It is intended to be copied into another project when the same player style is needed.

The visual direction is inspired by the interaction pattern observed in a Cosmos media element:

- content-first video presentation;
- muted autoplay;
- an unobtrusive circular sound toggle;
- a thin progress scrubber that appears on hover or focus;
- a soft bottom gradient that appears only when the player is being inspected;
- minimal icon-only controls;
- a calm, centered layout with no permanent control bar.

This is an interaction and styling reference, not a copy of Cosmos branding, logo, content, layout, or proprietary implementation. The surrounding downloader should use its own wordmark and controls.

## 2. Current source of truth

The current implementation lives in:

- Component: app/page.tsx
- Player styles: app/globals.css
- Icon package: @phosphor-icons/react
- Surrounding display typeface: Instrument Serif
- Interface typeface: Manrope

The current player component is named VideoPlayer and accepts one MediaItem:

~~~tsx
type MediaItem = {
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string;
};
~~~

The component is intentionally small. The browser owns playback, decoding, buffering, and seeking through the native HTMLVideoElement. React owns only the small amount of state required to synchronize custom visual controls.

## 3. Design thesis

### The player should feel quiet

The video is the primary object. Controls should not compete with it, create a permanent toolbar, or force the user to understand a complex interface.

### The player should feel native

Use a real HTML5 video element. Do not replace playback with a canvas, a frame-by-frame image system, or a custom media engine unless a future product requirement absolutely demands it.

### The player should reveal itself progressively

The default state is visually clean. Secondary chrome appears when the pointer is over the player or when a control receives focus.

### The player should be reversible

Every change is local and obvious:

- click the media to play or pause;
- click the sound button to mute or unmute;
- drag the progress line to seek;
- use the external-open action to view the source;
- use the download action to download manually.

### The player should not create hidden work

Loading a video must not start a download to the device. Downloading is an explicit user action. The browser should stream playback from the source URL and the application should avoid storing media on the server.

## 4. Experience contract

The following behavior is the contract. A port should preserve it unless the surrounding product has a strong reason to change it.

| Moment | Required behavior |
| --- | --- |
| First render | Render the poster when available and begin muted inline playback when the browser permits autoplay. |
| Playback start | Use autoplay, loop, muted, playsInline, and preload metadata. |
| Click on video | Toggle play and pause. |
| Click on sound control | Toggle muted state without toggling playback. |
| Hover over player | Reveal the bottom gradient and progress scrubber. |
| Focus inside player | Reveal the bottom gradient and progress scrubber. |
| Seek | Update the native video currentTime and the visible fill together. |
| Video action | Open the direct video URL in a new tab. |
| Download action | Start one explicit download for the selected media item. |
| No poster | Keep the shell background visible while the video loads. |
| Autoplay rejection | Leave the video paused or poster-visible without throwing an uncaught error. |
| End of video | Loop back to the beginning unless the host product explicitly disables looping. |

There is no permanent visible play button in this version. The media itself is the play/pause surface. There is no visible text inside the player.

## 5. Component anatomy

The player is layered inside the existing media frame. The media action buttons are siblings of the player shell so they can remain available without changing the video’s internal control model.

~~~text
media-frame
├── cosmos-video-shell
│   ├── video
│   ├── cosmos-video-gradient
│   ├── cosmos-mute-button
│   └── cosmos-video-progress
│       └── cosmos-video-track
│           ├── cosmos-video-fill
│           └── cosmos-video-range
└── media-actions
    ├── media-player      [video only]
    └── media-download
~~~

### Layer order

Use these conceptual layers:

| Layer | Content | Rule |
| --- | --- | --- |
| 0 | Video | Always visible, full available frame. |
| 1 | Bottom gradient | Pointer-events disabled; visual only. |
| 2 | Action controls | External-open and download actions. |
| 3 | Sound and progress controls | Interactive controls above the gradient. |

The gradient must never intercept pointer events. The video must remain clickable through it.

## 6. Component API

The minimal reusable API is:

~~~tsx
type VideoPlayerProps = {
  media: {
    type: "video";
    url: string;
    thumbnailUrl?: string;
  };
  label: string;
};

function VideoPlayer(props: VideoPlayerProps): JSX.Element;
~~~

The player should not know how a URL was resolved, where the media came from, or how a download is implemented. Those concerns belong to the parent.

Optional future props:

~~~tsx
type ExtendedVideoPlayerProps = VideoPlayerProps & {
  autoPlay?: boolean;
  loop?: boolean;
  initialMuted?: boolean;
  showExternalOpen?: boolean;
  onPlaybackChange?: (playing: boolean) => void;
  onMuteChange?: (muted: boolean) => void;
  onProgressChange?: (currentTime: number, duration: number) => void;
};
~~~

Keep the default behavior aligned with this document:

~~~tsx
{
  autoPlay: true,
  loop: true,
  initialMuted: true,
  showExternalOpen: true
}
~~~

## 7. Internal state model

The current component needs only three pieces of React state:

~~~tsx
const [muted, setMuted] = useState(true);
const [currentTime, setCurrentTime] = useState(0);
const [duration, setDuration] = useState(0);
~~~

The HTML video element remains the source of truth for actual playback. React state mirrors the values needed by the custom mute icon and progress fill.

### State responsibilities

| State | Source | Consumer |
| --- | --- | --- |
| muted | video.muted and onVolumeChange | Sound icon, accessible label, button title. |
| currentTime | video.currentTime and onTimeUpdate | Progress fill and range value. |
| duration | event.currentTarget.duration in onLoadedMetadata | Range max and percentage calculation. |

Do not create a second timer to calculate progress. Use onTimeUpdate so the browser’s media clock remains authoritative.

### Progress calculation

~~~tsx
const progress = duration
  ? Math.min((currentTime / duration) * 100, 100)
  : 0;
~~~

The progress value must be clamped to the 0–100 range. A duration of zero means that metadata is not ready and the range should be disabled.

## 8. Event and data flow

~~~text
media.url ───────────────► video.src
media.thumbnailUrl ──────► video.poster
video metadata event ────► duration state ─────► range max
video timeupdate ────────► currentTime state ──► fill width + range value
mute button click ───────► video.muted ─────────► muted state ─► icon
video click ─────────────► video.play() / pause()
range change ────────────► video.currentTime
~~~

### Playback toggle

~~~tsx
const togglePlayback = () => {
  const video = videoRef.current;
  if (!video) return;

  if (video.paused) {
    void video.play().catch(() => undefined);
  } else {
    video.pause();
  }
};
~~~

The play promise can reject because of browser autoplay or media-policy rules. Handle that rejection locally. Do not show an uncaught promise error.

### Mute toggle

~~~tsx
const toggleMute = () => {
  const video = videoRef.current;
  if (!video) return;

  video.muted = !video.muted;
  setMuted(video.muted);
};
~~~

The sound button must stop propagation so clicking it does not also toggle play/pause:

~~~tsx
onClick={(event) => {
  event.stopPropagation();
  toggleMute();
}}
~~~

### Seeking

~~~tsx
onChange={(event) => {
  const nextTime = Number(event.target.value);
  if (videoRef.current) {
    videoRef.current.currentTime = nextTime;
  }
  setCurrentTime(nextTime);
}}
~~~

The immediate state update keeps dragging responsive while the native video catches up.

## 9. Reference JSX structure

This is the compact reference implementation. It intentionally uses a native video element and a transparent range input over a styled track.

~~~tsx
function VideoPlayer({ media, label }: { media: MediaItem; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const progress = duration
    ? Math.min((currentTime / duration) * 100, 100)
    : 0;

  return (
    <div className="cosmos-video-shell">
      <video
        ref={videoRef}
        autoPlay
        loop
        muted={muted}
        playsInline
        preload="metadata"
        poster={media.thumbnailUrl}
        src={media.url}
        aria-label={label}
        onClick={togglePlayback}
        onLoadedMetadata={(event) =>
          setDuration(event.currentTarget.duration)
        }
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onVolumeChange={(event) =>
          setMuted(event.currentTarget.muted)
        }
      />

      <div className="cosmos-video-gradient" aria-hidden="true" />

      <button
        className="cosmos-mute-button"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          toggleMute();
        }}
        aria-label={muted ? "Unmute" : "Mute"}
        title={muted ? "Unmute" : "Mute"}
      >
        {muted ? (
          <SpeakerSlash size={17} weight="regular" />
        ) : (
          <SpeakerHigh size={17} weight="regular" />
        )}
      </button>

      <div className="cosmos-video-progress">
        <div className="cosmos-video-track">
          <span
            className="cosmos-video-fill"
            style={{ width: progress + "%" }}
          />
          <input
            className="cosmos-video-range"
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => {
              const nextTime = Number(event.target.value);
              if (videoRef.current) {
                videoRef.current.currentTime = nextTime;
              }
              setCurrentTime(nextTime);
            }}
            aria-label="Video progress"
            disabled={!duration}
          />
        </div>
      </div>
    </div>
  );
}
~~~

## 10. Visual design tokens

Use these tokens as the default theme. If the host project has its own brand palette, change the color values while preserving the contrast and role relationships.

### Palette

| Token | Current value | Role |
| --- | --- | --- |
| video shell background | #262825 | Fallback surface behind video and poster. |
| paper white | #fffefa | Video background, icons, light controls, progress fill. |
| ink black | #30342f | Focus outline and dark neutral UI. |
| rausch | #ff385c | Hover accent for sound and action controls. |
| rausch pressed | #e00b41 | Optional pressed accent for host buttons. |
| linen canvas | #f1efe9 | Outer page background. |
| panel | #f8f6f0 | Pale supporting surfaces. |
| line | rgba(48, 52, 47, 0.16) | Media frame border. |
| dark button | rgba(45, 56, 42, 0.93) | External-open and download buttons. |
| scrubber track | rgba(255, 254, 250, 0.28) | Inactive progress track. |
| bottom gradient | rgba(0, 0, 0, 0.72) to transparent | Temporary readability layer. |

Suggested variables:

~~~css
:root {
  --video-surface: #262825;
  --video-control-light: #fffefa;
  --video-control-dark: #30342f;
  --video-accent: #ff385c;
  --video-line: rgba(48, 52, 47, 0.16);
  --video-track: rgba(255, 254, 250, 0.28);
}
~~~

### Geometry

| Token | Value | Rule |
| --- | --- | --- |
| outer frame radius | 16px | Clip the media and all overlays. |
| sound control size | 32px | Desktop circular control. |
| sound control inset | 12px | Top and right offset inside the shell. |
| action control size | 34px | Desktop external-open/download control. |
| action control radius | 11px | Soft rounded square, not a circle. |
| action control gap | 5px | Space between adjacent action buttons. |
| progress horizontal inset | 8px | Distance from shell edges. |
| progress bottom inset | 6px | Keeps the line clear of the frame edge. |
| progress hit area | 14px | Transparent input hit target. |
| visible progress height | 4px | Thin visual line. |
| minimum multi-card width | 210px | Grid starts wrapping around this width. |
| multi-card gap | 12px | Consistent grid rhythm. |
| single-card max width | 760px | Centers a lone media item. |

### Typography

The player itself contains no visible text. Controls are icon-only and receive accessible labels and browser titles.

Surrounding application typography:

~~~css
--font-title: "Instrument Serif", Georgia, serif;
--font-interface: "Manrope", "Avenir Next", Avenir, Helvetica, Arial, sans-serif;
~~~

Use the display font for the surrounding product wordmark, not for player chrome. Keep player controls legible at small sizes and use a 17px icon by default. Do not reproduce a reference site’s logo or icon mark; use a plain, original wordmark for the host product.

### Iconography

Use Phosphor Icons or an equivalent thin, geometric icon set:

| Control | Icon | Size | Weight |
| --- | --- | --- | --- |
| muted state | SpeakerSlash | 17px | regular |
| unmuted state | SpeakerHigh | 17px | regular |
| open video | ArrowSquareOut | 17px | bold |
| download | DownloadSimple | 17px | bold |

Do not use a text label next to these icons in the default compact layout.

## 11. Reference CSS

The following rules are the visual core. Keep the class names or map them one-to-one to a different naming system.

~~~css
.media-frame {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--video-control-light);
  border: 1px solid var(--video-line);
  border-radius: 16px;
  box-shadow:
    0 8px 18px rgba(48, 52, 47, 0.08),
    inset 0 0 0 1px rgba(255, 255, 255, 0.7);
}

.media-frame img,
.media-frame video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--video-control-light);
}

.cosmos-video-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--video-surface);
}

.cosmos-video-shell video {
  cursor: pointer;
}

.cosmos-video-gradient {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.72),
    transparent 42%
  );
  opacity: 0;
  transition: opacity 180ms ease;
}

.cosmos-video-shell:hover .cosmos-video-gradient,
.cosmos-video-shell:focus-within .cosmos-video-gradient {
  opacity: 1;
}

.cosmos-mute-button {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--video-control-light);
  background: rgba(48, 52, 47, 0.28);
  border: 0;
  border-radius: 50%;
  box-shadow: 0 3px 8px rgba(48, 52, 47, 0.16);
  backdrop-filter: blur(10px);
  transition:
    color 180ms ease,
    background-color 180ms ease,
    transform 180ms ease;
}

.cosmos-mute-button:hover {
  color: var(--video-control-light);
  background: var(--video-accent);
  transform: scale(1.04);
}

.cosmos-mute-button:active {
  transform: scale(0.96);
}

.cosmos-video-progress {
  position: absolute;
  right: 8px;
  bottom: 6px;
  left: 8px;
  z-index: 3;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
}

.cosmos-video-shell:hover .cosmos-video-progress,
.cosmos-video-shell:focus-within .cosmos-video-progress {
  opacity: 1;
  pointer-events: auto;
}

.cosmos-video-track {
  position: relative;
  width: 100%;
  height: 14px;
  margin: 0;
  padding: 5px 0;
}

.cosmos-video-track::before,
.cosmos-video-fill {
  position: absolute;
  top: 5px;
  left: 0;
  display: block;
  height: 4px;
  border-radius: 999px;
}

.cosmos-video-track::before {
  width: 100%;
  content: "";
  background: var(--video-track);
}

.cosmos-video-fill {
  z-index: 1;
  background: var(--video-control-light);
  box-shadow: 0 0 7px rgba(255, 254, 250, 0.32);
  transition: width 120ms linear;
}

.cosmos-video-range {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 14px;
  margin: 0;
  cursor: pointer;
  opacity: 0;
}

.cosmos-video-range:disabled {
  cursor: wait;
}

.media-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 5px;
}

.media-actions.video-actions {
  right: auto;
  left: 8px;
}

.media-player,
.media-download {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: var(--video-control-light);
  background: rgba(45, 56, 42, 0.93);
  border: 0;
  border-radius: 11px;
  box-shadow: 0 4px 10px rgba(48, 52, 47, 0.15);
  transition:
    color 180ms ease,
    background-color 180ms ease,
    transform 180ms ease;
}

.media-player {
  text-decoration: none;
}

.media-player:hover,
.media-download:hover {
  color: var(--video-control-light);
  background: var(--video-accent);
}
~~~

## 12. Layout rules

### Single media item

Center the media and cap its width:

~~~css
.media-grid.single-media {
  display: flex;
  align-items: center;
  justify-content: center;
}

.single-media .media-card {
  width: min(100%, 760px);
  height: 100%;
  margin: 0 auto;
}
~~~

The single item should not appear stranded at the left edge or stretched across an unnecessarily wide canvas.

### Multiple media items

Use a compact grid:

~~~css
.media-grid.multi-media {
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(min(100%, 210px), 1fr)
  );
  gap: 12px;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
~~~

Each media card should use the same frame, radius, shadow, actions, and object-fit behavior. Do not introduce a special visual treatment for the second or later item.

### Responsive behavior

At widths below 520px:

~~~css
.media-actions {
  top: 6px;
  right: 6px;
}

.media-actions.video-actions {
  right: auto;
  left: 6px;
}

.media-player,
.media-download {
  width: 31px;
  height: 31px;
}
~~~

Keep the sound toggle in the top-right and move the video external-open/download group to the top-left. This prevents the controls from colliding on narrow screens.

## 13. Media sizing and quality rules

- Prefer the highest-quality direct video URL available from the resolver.
- Use the thumbnail only as poster artwork; never download the poster as a video replacement.
- Keep the original aspect ratio with object-fit: contain.
- Do not stretch, crop, or force a portrait video into a landscape crop.
- Preserve the media frame’s background around letterboxed content.
- Use preload metadata to limit initial network work while still obtaining duration.
- Use a direct HTTPS URL when possible.
- Give the browser a poster when the source exposes one.
- Keep playback and downloading separate.
- For a carousel, create one independent player per video item.
- For a mixed carousel, render videos as videos and images as images. Never display a video thumbnail as an image item when a direct video rendition exists.

## 14. Download and external-open boundaries

The player and the download system are separate responsibilities.

### Open in new tab

The external-open control should:

~~~tsx
<a
  className="media-player"
  href={media.url}
  target="_blank"
  rel="noreferrer"
  aria-label="Open video in a new tab"
  title="Open in new tab"
>
  <ArrowSquareOut size={17} weight="bold" />
</a>
~~~

Use the ArrowSquareOut icon because the action opens a new context. Do not use a generic play icon for this action.

### Manual download

The download button should be an explicit button owned by the parent:

~~~tsx
<button
  className="media-download"
  type="button"
  onClick={() => onDownload(media, source, index, total)}
  aria-label={"Download " + media.type + " " + (index + 1)}
  title={"Download " + media.type}
>
  <DownloadSimple size={17} weight="bold" />
</button>
~~~

Do not start a download from:

- component mount;
- poster load;
- video play;
- video metadata load;
- paste or resolve completion.

## 15. Text and labeling rules

Visible player text: none.

Required accessible and tooltip text:

| Element | Accessible label | Tooltip/title |
| --- | --- | --- |
| Video | A contextual label such as “Post video 1”. | Usually none. |
| Sound button while muted | Unmute | Unmute |
| Sound button while unmuted | Mute | Mute |
| Progress range | Video progress | Usually none. |
| External-open action | Open video in a new tab | Open in new tab |
| Download action | Download video 1 | Download video |

Labels should describe the action, not the icon’s appearance. Avoid labels such as “speaker icon” or “arrow icon”.

For images in the same grid, use a parallel label such as “Post image 1”.

## 16. Accessibility requirements

The current component already includes labels on the video, sound button, and range input. Any future port should also satisfy the following:

- Keep the sound control a real button.
- Keep the seek control a real input of type range.
- Keep the external-open action a real anchor.
- Keep the download action a real button.
- Preserve visible focus with a 2px outline and 3px offset.
- Never rely on color alone to communicate mute state; swap the icon and accessible label.
- Stop sound-button propagation so it does not activate the media surface.
- Add keyboard access to play/pause if the video surface is used as a custom control.
- Respect reduced-motion preferences.
- Do not hide focus indicators for keyboard users.

Recommended keyboard enhancement for the clickable video surface:

~~~tsx
<video
  tabIndex={0}
  onKeyDown={(event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      togglePlayback();
    }
  }}
/>
~~~

If the host project uses native video controls instead of this custom chrome, do not duplicate browser controls with a second visible control bar.

Recommended focus rule:

~~~css
:focus-visible {
  outline: 2px solid var(--video-control-dark);
  outline-offset: 3px;
}
~~~

Recommended reduced-motion rule:

~~~css
@media (prefers-reduced-motion: reduce) {
  .cosmos-video-gradient,
  .cosmos-video-progress,
  .cosmos-video-fill,
  .cosmos-mute-button,
  .media-player,
  .media-download {
    transition: none;
  }
}
~~~

## 17. Interaction details and motion

Motion should be short, soft, and functional.

| Interaction | Duration | Easing | Result |
| --- | --- | --- | --- |
| Gradient reveal | 180ms | ease | Bottom readability layer fades in. |
| Progress reveal | 180ms | ease | Scrubber becomes available. |
| Progress fill | 120ms | linear | Fill tracks current time without visible jitter. |
| Sound hover | 180ms | ease | Accent background and 1.04 scale. |
| Sound press | immediate | ease | 0.96 scale gives tactile feedback. |
| Action hover | 180ms | ease | Dark control changes to accent. |

Do not add:

- bounce effects;
- animated control labels;
- persistent floating toolbars;
- strong glow around the whole video;
- parallax or decorative motion;
- progress animations unrelated to playback.

## 18. Loading, error, and edge states

### Loading

The player may show the poster while metadata is loading. The progress input remains disabled until duration is known.

### Autoplay blocked

Do not treat autoplay rejection as an application error. The user can click the media to start it. Keep the poster and sound control usable.

### Missing duration

When duration is zero or not finite:

- show no meaningful fill;
- disable the range input;
- retain the video and poster;
- avoid dividing by zero.

### Source error

The reusable version should add an error callback or state:

~~~tsx
const [hasError, setHasError] = useState(false);

<video onError={() => setHasError(true)} />
~~~

Recommended fallback:

- keep the frame;
- show the poster if available;
- provide the external-open action;
- show one short visible message outside the media if the host product needs to explain the failure.

### Unsupported format

Prefer MP4/H.264 for broad browser support. If multiple sources are available, provide source elements or choose a browser-compatible rendition before rendering.

### Cross-origin media

Use HTTPS media URLs. If the application later needs canvas processing or authenticated media, configure CORS explicitly. Playback and download permissions are separate concerns.

### Very short videos

The player still uses the same scrubber. Do not make a special miniature control for short clips.

### Long videos

Keep the same design but consider a poster-first load strategy and avoid preloading full content.

## 19. Implementation folder suggestion

When moving this into a new codebase, use a self-contained module:

~~~text
components/
└── video-player/
    ├── VideoPlayer.tsx
    ├── video-player.css
    ├── video-player.types.ts
    └── README.md
~~~

Suggested responsibilities:

| File | Responsibility |
| --- | --- |
| VideoPlayer.tsx | Native video, playback events, mute state, progress state. |
| video-player.css | Shell, gradient, sound control, scrubber, responsive rules. |
| video-player.types.ts | Media and component contracts. |
| README.md | Host-project integration and source requirements. |

Keep downloading, source resolution, carousel composition, analytics, and persistence outside the player module.

## 20. Integration recipe

1. Resolve or receive one direct video URL.
2. Build a MediaItem with type video and optional thumbnailUrl.
3. Render the player inside a parent with a definite width and height.
4. Add the external-open and manual-download actions as sibling controls.
5. Use a centered max width for one item.
6. Use a 210px minimum grid track for multiple items.
7. Keep muted autoplay enabled by default.
8. Verify the sound control does not trigger play/pause.
9. Verify the scrubber appears on hover and keyboard focus.
10. Verify the media URL is not downloaded until the user clicks download.
11. Test desktop, 520px mobile, and 320px narrow layouts.
12. Run typecheck, production build, and a real browser smoke test.

## 21. Visual QA checklist

### Composition

- [ ] One video is centered.
- [ ] Multiple media items form a symmetrical grid.
- [ ] The media frame has a 16px radius and subtle border.
- [ ] The video is not cropped by default.
- [ ] There is no unexplained extra whitespace inside the frame.

### Controls

- [ ] Sound button is circular, 32px desktop, 31px mobile.
- [ ] Sound button is top-right.
- [ ] Video open/download actions are top-left.
- [ ] The open action uses an external-link icon.
- [ ] The download action uses a download icon.
- [ ] Icons are 17px and visually centered.
- [ ] Controls have a dark idle state and coral hover state.

### Playback

- [ ] Video starts muted when autoplay is allowed.
- [ ] Video loops.
- [ ] Video stays inline on mobile.
- [ ] Clicking the media toggles play/pause.
- [ ] Sound toggle changes the actual video.muted property.
- [ ] Seeking updates the actual video.currentTime property.
- [ ] Poster is shown while media is loading when available.
- [ ] The video thumbnail is never downloaded as a separate media item.

### Reveal behavior

- [ ] Gradient is invisible at rest.
- [ ] Gradient fades in on hover.
- [ ] Gradient fades in on focus-within.
- [ ] Scrubber is hidden at rest.
- [ ] Scrubber is interactive when revealed.
- [ ] Gradient never blocks pointer input.

### Accessibility

- [ ] All icon-only controls have accessible labels.
- [ ] Focus is visible.
- [ ] Range input is labeled.
- [ ] Keyboard play/pause is supported in the port.
- [ ] Reduced motion is respected.

## 22. Do and do not

### Do

- Do use native HTML5 video.
- Do start muted for autoplay compatibility.
- Do keep controls minimal.
- Do use the poster as a loading surface.
- Do preserve the original aspect ratio.
- Do reveal controls on hover and focus.
- Do separate playback from downloading.
- Do keep the component independent from the media resolver.
- Do use direct source URLs and high-quality renditions.
- Do move top-right action groups when they would collide with the sound control.

### Do not

- Do not auto-download on paste, resolve, mount, or playback.
- Do not show a thumbnail instead of a discovered video URL.
- Do not use a zip archive when the product requires individual files.
- Do not hard-code account-specific or post-specific logic into the player.
- Do not add visible control text to the compact version.
- Do not use a play icon for “open in new tab”.
- Do not hide the only focus indicator.
- Do not use a custom progress timer disconnected from the video element.
- Do not use object-fit cover unless the host explicitly wants cropping.
- Do not store played media on the server unless a separate product requirement authorizes it.

## 23. Porting notes

The player style is portable because it depends on very little:

- one native video element;
- one React ref;
- three small state values;
- one button for sound;
- one range input for seeking;
- one decorative gradient;
- one visual progress fill;
- one consistent set of geometry and color tokens.

If the next project already uses a media library, keep this visual contract and replace only the playback event wiring. The user should still experience the same quiet surface, sound toggle, hover reveal, scrubber, and action placement.

If the next project supports several videos on one screen, keep state inside each player instance. Do not use one global currentTime or muted value for the whole page.

## 24. Reference implementation status

This specification reflects the player shipped in the Instagram Downloader after the Cosmos-inspired video controls update. The key implementation decisions are:

- native HTML5 video underneath;
- no permanent native control bar;
- muted autoplay and looping;
- click-to-toggle playback;
- circular sound control;
- custom thin range scrubber;
- hover/focus reveal;
- top-left external-open/download actions for videos;
- centered single-media presentation;
- responsive multi-media grid;
- manual downloads only.

Use this document as the design contract. If a future implementation changes the interaction, update this file at the same time so it remains the reliable handoff artifact.
