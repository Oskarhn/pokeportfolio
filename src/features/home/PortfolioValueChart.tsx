/*
 * M12 Home portfolio-value chart.
 *
 * CHART LIBRARY / ATTRIBUTION (DECISIONS.md D-066, prompt §7-§9).
 * This surface uses TradingView Lightweight Charts™ v5.2.1 (npm `lightweight-charts`),
 * Apache-2.0 with a NOTICE requirement. The license requires specifying TradingView as the
 * product creator: the NOTICE attribution ("TradingView Lightweight Charts™, Copyright (c)
 * 2025 TradingView, Inc. https://www.tradingview.com/" — as published at the v5.2.1 tag)
 * lives here in the source, and the required
 * user-visible link to https://www.tradingview.com/ is rendered by this component's footer —
 * alongside the chart's own built-in attribution logo (`layout.attributionLogo`, kept at its
 * default-enabled value), which the official docs name as a sufficient way to satisfy the link
 * requirement. The footer is deliberately restrained (10px muted text), consistent with the
 * app's existing provider attributions, and never dominates the UI.
 *
 * The library is loaded through dynamic import() so its ~185 KB production bundle stays out of
 * the initial route chunk — Home IS the initial route, so this matters (prompt §107).
 *
 * PRIVACY (prompt §75): when `hidden` is true the price scale is removed entirely and the
 * crosshair is disabled — an axis that still showed kroner would defeat the eye. The line's
 * SHAPE remains visible, which reveals trend, not amount; the accessible summary below the
 * chart masks dated values too.
 */

import { useEffect, useRef, useState } from 'react'
import type {
  AreaSeriesOptions,
  ChartOptions,
  DeepPartial,
  IChartApi,
  ISeriesApi,
} from 'lightweight-charts'
import type { ChartSeriesPoint } from '../../domain/dashboard'

interface ChartColors {
  text: string
  grid: string
  border: string
  line: string
  areaTop: string
  areaBottom: string
}

function readChartColors(): ChartColors {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  const accent = read('--pp-accent')
  return {
    text: read('--pp-text-secondary'),
    grid: read('--pp-step-1'),
    border: read('--pp-step-2'),
    line: accent || '#b08d57',
    areaTop: 'rgba(143, 95, 53, 0.28)',
    areaBottom: 'rgba(143, 95, 53, 0.02)',
  }
}

/** Tracks light/dark/system without a page reload (prompt §105) by watching the `data-theme`
 *  attribute the Profile theme control sets on <html>. */
function useObservedChartColors(): ChartColors {
  const [colors, setColors] = useState(readChartColors)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setColors(readChartColors())
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    })
    return () => {
      observer.disconnect()
    }
  }, [])
  return colors
}

export function PortfolioValueChart({
  points,
  hidden,
}: {
  points: ChartSeriesPoint[]
  hidden: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)
  const colors = useObservedChartColors()

  // Create once; every later change flows through applyOptions/setData so the chart instance
  // (and its scroll position) survives range flips and theme switches.
  useEffect(() => {
    // Boxed + accessed through a getter so neither control-flow analysis nor
    // no-unnecessary-condition can prove it never flips between await points.
    const state = { disposed: false }
    const isDisposed = () => state.disposed
    let resizeObserver: ResizeObserver | null = null

    async function mount() {
      const container = containerRef.current
      if (!container || isDisposed()) return

      const lib = await import('lightweight-charts')
      const containerNow = containerRef.current
      if (isDisposed() || containerNow === null) return

      const options: DeepPartial<ChartOptions> = {
        layout: {
          background: { type: lib.ColorType.Solid, color: 'transparent' },
          textColor: colors.text,
          fontSize: 11,
          attributionLogo: true,
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { color: colors.grid },
        },
        rightPriceScale: { visible: !hidden, borderColor: colors.border },
        timeScale: { borderColor: colors.border, rightOffset: 2 },
        crosshair: {
          mode: hidden ? lib.CrosshairMode.Hidden : lib.CrosshairMode.Normal,
        },
        localization: {
          priceFormatter: (price: number) =>
            new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(price),
        },
        handleScale: { axisPressedMouseMove: { price: false } },
        autoSize: false,
      }

      const chart = lib.createChart(containerNow, options)
      const area: Partial<AreaSeriesOptions> = {
        lineColor: colors.line,
        topColor: colors.areaTop,
        bottomColor: colors.areaBottom,
        lineWidth: 2,
        pointMarkersVisible: false,
      }
      const series = chart.addSeries(lib.AreaSeries, area)
      chartRef.current = chart
      seriesRef.current = series

      series.setData(points)
      chart.timeScale().fitContent()

      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        chart.resize(entry.contentRect.width, entry.contentRect.height)
      })
      resizeObserver.observe(container)
    }

    void mount()

    return () => {
      state.disposed = true
      resizeObserver?.disconnect()
      chartRef.current?.remove()
      chartRef.current = null
      seriesRef.current = null
    }
    // Mount-once semantics: data/options updates are handled below, never by remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Data updates (range changes, refreshes).
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    series.setData(points)
    chartRef.current?.timeScale().fitContent()
  }, [points])

  // Option updates (privacy toggle, theme flip) without remounting.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    void import('lightweight-charts').then((lib) => {
      chart.applyOptions({
        layout: { textColor: colors.text },
        grid: { horzLines: { color: colors.grid } },
        rightPriceScale: { visible: !hidden, borderColor: colors.border },
        timeScale: { borderColor: colors.border },
        crosshair: {
          mode: hidden ? lib.CrosshairMode.Hidden : lib.CrosshairMode.Normal,
        },
      })
      const series = seriesRef.current
      series?.applyOptions({
        lineColor: colors.line,
        topColor: colors.areaTop,
        bottomColor: colors.areaBottom,
      })
    })
  }, [colors, hidden])

  return (
    <div className="relative">
      <div ref={containerRef} className="h-48 w-full sm:h-56" aria-hidden="true" />
      {/* Restrained, user-visible attribution — see the license note at the top of this file. */}
      <p className="mt-1 text-right text-[10px] text-slate-600">
        Charts by{' '}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-slate-700 underline-offset-2 hover:text-slate-400"
        >
          TradingView
        </a>{' '}
        Lightweight Charts
      </p>
    </div>
  )
}
