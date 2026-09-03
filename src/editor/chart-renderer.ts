import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartDataset,
} from 'chart.js'

Chart.register(CategoryScale, LinearScale, BarController, BarElement, LineController, LineElement, PointElement, Legend, Tooltip)

export interface DeclarativeChartModel {
  kind: 'line' | 'bar'
  labels: string[]
  series: Array<{ label: string; values: number[] }>
  colors: string[]
  textColor: string
  gridColor: string
}

export interface RenderedChart {
  destroy(): void
  durationMs: number
}

/** Render already-validated table data; document text never becomes code or callbacks. */
export function renderDeclarativeChart(canvas: HTMLCanvasElement, model: DeclarativeChartModel): RenderedChart {
  const started = performance.now()
  // Parsing is off, so every point is already in Chart.js's internal shape: the
  // category index on x and the finite value on y (bars draw nothing from bare numbers).
  const datasets: ChartDataset<'line' | 'bar', Array<{ x: number; y: number }>>[] = model.series.map((series, index) => ({
    label: series.label,
    data: series.values.map((value, position) => ({ x: position, y: value })),
    borderColor: model.colors[index],
    backgroundColor: model.kind === 'bar' ? model.colors[index] : `${model.colors[index]}33`,
    borderWidth: 2,
    pointRadius: model.labels.length > 80 ? 0 : 2,
    tension: 0,
  }))
  const chart = new Chart(canvas, {
    type: model.kind,
    data: { labels: model.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: model.textColor, boxWidth: 12, boxHeight: 12 } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { ticks: { color: model.textColor, maxRotation: 0, sampleSize: 24 }, grid: { color: model.gridColor } },
        y: { ticks: { color: model.textColor }, grid: { color: model.gridColor } },
      },
    },
  })
  return { destroy: () => chart.destroy(), durationMs: performance.now() - started }
}
