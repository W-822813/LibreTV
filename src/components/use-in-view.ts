'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 一次性「进入视口」判定，用于搜索结果里的单源卡片延迟探测。
 *
 * 两个刻意的设计：
 * - 进入视口后再等 `delayMs`（默认 500ms）才置位：快速滚过列表时不会沿途触发探测，
 *   只有真正停下来看的卡片才会发请求；
 * - 一旦置位就永久为 true 并断开 observer：卡片滚出视口也不撤销（结果已缓存，撤销反而要重探）。
 *
 * 无 IntersectionObserver（老浏览器 / 测试环境）时直接视为可见，由调用方的缓存与队列限流兜底。
 */
export function useInView<T extends HTMLElement>(enabled = true, delayMs = 500) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!enabled || inView) return;
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    // rootMargin 提前 120px：卡片刚露头就开始争取首屏的点亮时间，但不至于提前太多
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        timer = setTimeout(() => setInView(true), delayMs);
      },
      { rootMargin: '120px' }
    );
    observer.observe(el);

    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, [enabled, inView, delayMs]);

  return { ref, inView };
}
