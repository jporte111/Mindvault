import { useState, useRef } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

export default function PullToRefresh({ onRefresh, children }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(null);
  const threshold = 70;

  const onTouchStart = (e) => {
    startY.current = window.scrollY <= 0 ? e.touches[0].clientY : null;
  };
  const onTouchMove = (e) => {
    if (startY.current === null) return;
    const diff = e.touches[0].clientY - startY.current;
    if (diff > 0 && window.scrollY <= 0) setPull(Math.min(diff * 0.5, threshold + 30));
  };
  const onTouchEnd = async () => {
    if (startY.current === null) return;
    if (pull >= threshold) {
      setRefreshing(true);
      setPull(threshold);
      try { await onRefresh?.(); } finally {
        setRefreshing(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
    startY.current = null;
  };

  const height = refreshing ? 44 : pull;

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div
        className="flex items-center justify-center overflow-hidden transition-all duration-150"
        style={{ height }}
      >
        {refreshing ? (
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        ) : pull > 10 ? (
          <RefreshCw
            className="w-5 h-5 text-primary transition-opacity"
            style={{ opacity: Math.min(pull / threshold, 1) }}
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}