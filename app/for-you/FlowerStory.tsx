'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import styles from './story.module.css';

const Rose2DScene = dynamic(() => import('../components/rose2d/Rose2DScene'), {
    ssr: false,
    loading: () => <div className={styles.fallback} />,
});
const GiftScene = dynamic(() => import('../components/rose2d/GiftScene'), {
    ssr: false,
    loading: () => <div className={styles.fallback} />,
});

function Petals({ dense = false }: { dense?: boolean }) {
    const count = dense ? 18 : 10;
    return <div className={`${styles.petals} ${dense ? styles.petalsDense : ''}`} aria-hidden='true'>{Array.from({ length: count }, (_, i) => <span key={i} className={styles.petal} />)}</div>;
}

function Button({ children, onClick, quiet = false }: { children: ReactNode; onClick: () => void; quiet?: boolean }) {
    return <button type='button' className={`${styles.action} ${quiet ? styles.quietAction : ''}`} onClick={onClick}>{children}</button>;
}

function DelayedContent({ delay, children }: { delay: number; children: ReactNode }) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const timer = window.setTimeout(() => setReady(true), delay);
        return () => window.clearTimeout(timer);
    }, [delay]);
    return ready ? children : null;
}

function DelayedButton({ delay, children, onClick }: { delay: number; children: ReactNode; onClick: () => void }) {
    return <div className={styles.delayedActionSlot}><DelayedContent delay={delay}><div className={styles.delayedAction}><Button onClick={onClick}>{children}</Button></div></DelayedContent></div>;
}

type RoseMode = 'interactive' | 'wish' | 'background' | 'showcase';
function Rose({ mode = 'interactive' }: { mode?: RoseMode }) {
    return <div className={styles.rose}><Rose2DScene layout={mode} /></div>;
}

const GIFT_COPY = [
    { text: 'Bình thường, bạn là người chuẩn bị hoa cho người khác.', secondary: false },
    { text: 'Nhưng hôm nay là 20/10 mà...', secondary: true },
    { text: 'Nên lần này, nhận một bông hoa dành riêng cho mình nha', secondary: false },
] as const;

const WORD_READING_TIME = 340;
const LINE_PAUSE = 500;
// Fine-tune when each gift line starts. Negative values make a line appear sooner.
const GIFT_LINE_START_ADJUSTMENTS = [0, -450, 0] as const;
const GIFT_CTA_DELAY_AFTER_LAST_LINE = 450;
let giftCopyCursor = 400;
const GIFT_COPY_TIMING = GIFT_COPY.map(({ text }, index) => {
    const delay = giftCopyCursor + GIFT_LINE_START_ADJUSTMENTS[index];
    const words = text.trim().split(/\s+/).length;
    const readingTime = Math.min(Math.max(words * WORD_READING_TIME, 1800), 5000);
    const revealTime = Math.min(Math.max(650 + text.length * 5, 700), 1050);
    giftCopyCursor += readingTime + LINE_PAUSE;
    return { delay, revealTime };
});
const lastGiftLineTiming = GIFT_COPY_TIMING.at(-1)!;
const GIFT_OPEN_DELAY = lastGiftLineTiming.delay
    + lastGiftLineTiming.revealTime
    + GIFT_CTA_DELAY_AFTER_LAST_LINE;
const GIFT_COPY_EXIT_DURATION = 600;
const GIFT_RECENTER_DURATION = 650;

const SHOWCASE_BOKEH_COUNT = 10;
const SHOWCASE_STAR_COUNT = 18;

export default function FlowerStory() {
    const [scene, setScene] = useState(0);
    const [giftPlay, setGiftPlay] = useState(0);
    const [giftStarting, setGiftStarting] = useState(false);
    const [giftOpened, setGiftOpened] = useState(false);
    const [giftFading, setGiftFading] = useState(false);
    const [giftReady, setGiftReady] = useState(false);
    const [giftShifted, setGiftShifted] = useState(false);
    const [giftTextReady, setGiftTextReady] = useState(false);
    const [audioActivated, setAudioActivated] = useState(false);
    const [muted, setMuted] = useState(false);
    const [playing, setPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement>(null);

    useEffect(() => {
        const stopAudio = () => {
            const audio = audioRef.current;
            if (!audio) return;
            audio.pause();
            audio.currentTime = 0;
        };

        window.addEventListener('pagehide', stopAudio);
        return () => {
            window.removeEventListener('pagehide', stopAudio);
            stopAudio();
        };
    }, []);
    useEffect(() => {
        if (scene !== 1) return;

        // Warm the next scene without mounting a full-screen WebGL canvas over
        // the current one. Both the code chunk and artwork will be cached before
        // the viewer presses the continue button.
        void import('../components/rose2d/GiftScene');
        void fetch('/rose2d/rose.json');
        for (const src of ['/rose2d/rose.webp', '/rose2d/fx.png']) {
            const image = new Image();
            image.src = src;
        }
    }, [scene]);

    useEffect(() => {
        if (scene !== 2 || !giftReady) return;

        // First let the viewer see the gift in the centre. Then move it down to
        // make room for the copy. The copy owns its own staggered reading rhythm.
        const shiftTimer = window.setTimeout(() => setGiftShifted(true), 2850);
        const copyTimer = window.setTimeout(() => setGiftTextReady(true), 4550);
        return () => {
            window.clearTimeout(shiftTimer);
            window.clearTimeout(copyTimer);
        };
    }, [scene, giftReady]);



    const playAudio = async (restart = false) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.volume = 0.55;
        if (restart) audio.currentTime = 0;
        audio.muted = false;
        setMuted(false);
        try {
            await audio.play();
            setPlaying(true);
            setAudioActivated(true);
        } catch {
            setPlaying(false);
        }
    };

    const beginStory = () => {
        void playAudio(true);
        setScene(1);
    };

    const toggleMusic = () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused || !audioActivated) {
            void playAudio(false);
            return;
        }
        audio.muted = !audio.muted;
        setMuted(audio.muted);
    };

    const replay = () => {
        setGiftPlay(0);
        setGiftStarting(false);
        setGiftOpened(false);
        setGiftFading(false);
        setGiftReady(false);
        setGiftShifted(false);
        setGiftTextReady(false);
        void playAudio(true);
        setScene(1);
    };

    const openGift = () => {
        setGiftStarting(true);
        window.setTimeout(() => setGiftShifted(false), GIFT_COPY_EXIT_DURATION);
        window.setTimeout(
            () => setGiftPlay(1),
            GIFT_COPY_EXIT_DURATION + GIFT_RECENTER_DURATION,
        );
    };

    const finishGift = () => {
        setGiftOpened(true);
    };

    const enterGiftScene = () => {
        setGiftReady(false);
        setGiftShifted(false);
        setGiftTextReady(false);
        setScene(2);
    };

    const continueFromGift = () => {
        setGiftFading(true);
        window.setTimeout(() => setScene(5), 900);
    };

    const moveShowcaseLight = (event: PointerEvent<HTMLElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / bounds.width) * 100;
        const y = ((event.clientY - bounds.top) / bounds.height) * 100;
        event.currentTarget.style.setProperty('--showcase-x', `${x}%`);
        event.currentTarget.style.setProperty('--showcase-y', `${y}%`);
    };

    const resetShowcaseLight = (event: PointerEvent<HTMLElement>) => {
        event.currentTarget.style.setProperty('--showcase-x', '50%');
        event.currentTarget.style.setProperty('--showcase-y', '44%');
    };
    const progressStep = scene === 1 ? 1 : scene === 2 ? 2 : scene === 5 ? 3 : scene === 6 ? 4 : scene === 7 ? 5 : 0;
    return <main className={styles.story}>
        <audio ref={audioRef} src='/music.mp3' loop preload='auto' onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />

        {scene > 0 && <button type='button' className={styles.sound} onClick={toggleMusic} aria-label={playing && !muted ? 'Tắt nhạc' : 'Bật nhạc'} title={playing && !muted ? 'Tắt nhạc' : 'Bật nhạc'}>
            <span className={styles.soundBars} data-active={playing && !muted} aria-hidden='true'><i /><i /><i /></span>
            <span>{playing && !muted ? 'Nhạc đang phát' : 'Bật nhạc'}</span>
        </button>}

        <div key={scene} className={`${styles.transition} ${scene === 2 ? styles.giftTransition : ''}`}>
            {scene === 0 && <section className={`${styles.scene} ${styles.welcome}`}>
                <Petals />
                <div className={styles.welcomeGlow} aria-hidden='true' />
                <div className={styles.welcomeContent}>
                    <span className={styles.mark} aria-hidden='true'>✦</span>
                    <p className={styles.kicker}>20 · 10 · 2026</p>
                    <h1>Một món quà nhỏ<br />đang chờ bạn</h1>
                    <p>Chạm để bắt đầu và nghe một chút nhạc nhé.</p>
                    <Button onClick={beginStory}><span aria-hidden='true'>♪</span> Chạm để mở món quà</Button>
                </div>
            </section>}

            {scene === 1 && <section className={`${styles.scene} ${styles.paper}`}>
                <Petals /><div className={styles.orbit} aria-hidden='true'><span /></div>
                <div className={styles.copy}>
                    <p className={styles.kicker}>MỘT ĐIỀU NHỎ · 20.10</p>
                    <div className={`${styles.lines} ${styles.stagger}`}><p>Hi... <span aria-hidden='true'>😶</span></p><p>Hôm nay của bạn thế nào rồi?</p><p className={styles.secondary}>Mình có cái này muốn cho bạn xem😶</p></div>
                    <DelayedButton delay={6200} onClick={enterGiftScene}>Xem gì thế? <span aria-hidden='true'>→</span></DelayedButton>
                </div>
            </section>}

            {scene === 2 && <section className={`${styles.scene} ${styles.giftScene}`}>
                <div
                    className={`${styles.giftCanvas} ${giftReady ? styles.giftCanvasVisible : ''}`}
                >
                    <GiftScene play={giftPlay} lowered={giftShifted} insetTop={0} insetBottom={0} onReady={() => setGiftReady(true)} onDone={finishGift} />
                </div>
                {giftTextReady && <div className={`${styles.giftScrim} ${giftStarting ? styles.giftCopyLeaving : ''}`}>
                    <div className={`${styles.giftLines} ${styles.stagger}`}>
                        {GIFT_COPY.map((line, index) => <p
                            key={line.text}
                            className={line.secondary ? styles.secondary : undefined}
                            style={{ animationDelay: `${GIFT_COPY_TIMING[index].delay}ms`, animationDuration: `${GIFT_COPY_TIMING[index].revealTime}ms` }}
                        >{line.text}{index === GIFT_COPY.length - 1 && <> <span aria-hidden='true'>:&gt;</span></>}</p>)}
                    </div>
                </div>}
                {giftTextReady && !giftStarting && <DelayedContent delay={GIFT_OPEN_DELAY}><div className={styles.openGiftControls}>
                    <p className={styles.openGiftHint}>Chạm vào bó hoa để mở</p>
                    <button type='button' className={styles.openGiftTarget} onClick={openGift} aria-label='Chạm vào bó hoa để mở' />
                </div></DelayedContent>}
                {giftStarting && !giftOpened && <p className={styles.openingLabel}>Món quà đang mở…</p>}
                {giftOpened && !giftFading && <div className={`${styles.bottom} ${styles.giftContinue}`}><Button onClick={continueFromGift}>Trang tiếp <span aria-hidden='true'>→</span></Button></div>}
                {giftFading && <div className={styles.giftFade} aria-hidden='true' />}
            </section>}

            {scene === 5 && <section className={`${styles.scene} ${styles.roseScene}`}>
                <Rose mode='wish' /><div className={styles.wishShade} aria-hidden='true' />
                <div className={`${styles.overlay} ${styles.wish} ${styles.stagger}`}><p className={styles.kicker}>MỘT LỜI CHÚC NHỎ</p><p>Chúc bạn một ngày 20/10 thật vui vẻ :&gt;</p><p className={styles.secondary}>Mong mọi chuyện đều suôn sẻ, gặp thật nhiều điều dễ thương</p><p className={styles.secondary}>Và đừng quên dành một chút thời gian cho bản thân nữa nha :&gt;</p></div>
                <div className={styles.bottom}><DelayedButton delay={10700} onClick={() => setScene(6)}>Tiếp tục <span aria-hidden='true'>→</span></DelayedButton></div>
            </section>}

            {scene === 6 && <section className={`${styles.scene} ${styles.roseScene}`}>
                <Rose mode='background' /><Petals /><div className={styles.cardShade} aria-hidden='true' />
                <article className={styles.card}><p className={styles.date}>20.10.2026</p><span className={styles.flourish} aria-hidden='true'>✦</span><p>Hy vọng món quà nhỏ này khiến bạn vui hơn một chút.</p><h1>Đừng quên:<br />bạn cũng là một bông hoa :&gt;</h1><Button onClick={() => setScene(7)}>Ngắm hoa thêm chút nữa <span aria-hidden='true'>→</span></Button></article>
            </section>}

            {scene === 7 && <section className={`${styles.scene} ${styles.showcase}`} onPointerMove={moveShowcaseLight} onPointerLeave={resetShowcaseLight}>
                <Rose mode='showcase' />
                <div className={styles.showcaseAtmosphere} aria-hidden='true'>
                    <div className={styles.showcaseAura} />
                    <div className={`${styles.bokehField} ${styles.bokehFar}`}>{Array.from({ length: SHOWCASE_BOKEH_COUNT }, (_, i) => <i key={i} />)}</div>
                    <div className={`${styles.bokehField} ${styles.bokehNear}`}>{Array.from({ length: SHOWCASE_BOKEH_COUNT }, (_, i) => <i key={i} />)}</div>
                    <div className={styles.starField}>{Array.from({ length: SHOWCASE_STAR_COUNT }, (_, i) => <i key={i} />)}</div>
                    <div className={styles.showcaseVignette} />
                </div>
                <Petals dense />
                <div className={styles.replay}><Button quiet onClick={replay}>Xem lại từ đầu <span aria-hidden='true'>↺</span></Button></div>
            </section>}
        </div>

        {progressStep > 0 && progressStep < 5 && <div className={styles.progress} aria-label={`Cảnh ${progressStep} trên 5`}><span>{String(progressStep).padStart(2, '0')}</span><div><i style={{ width: `${(progressStep / 5) * 100}%` }} /></div><span>05</span></div>}
    </main>;
}







