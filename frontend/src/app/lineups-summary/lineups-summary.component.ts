import { AfterViewInit, ChangeDetectorRef, Component, DestroyRef, OnInit, ViewChild, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSliderModule } from '@angular/material/slider';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject, switchMap } from 'rxjs';

import { Lineup, LineupQuery } from '../_services/lineup.models';
import { LineupsService } from '../_services/lineups.service';

interface TeamOption {
  id: string;
  name: string;
}

interface PlayerOption {
  id: string;
  name: string;
  teamId: string;
}

/** One dot on the ORtg vs DRtg chart. */
interface ChartDot {
  key: string;
  x: number;
  y: number;
  r: number;
  color: string;
  label: string;
  row: Lineup;
}

interface ChartTick {
  value: number;
  pos: number;
}

/** Everything the SVG needs, pre-computed in pixels whenever the data changes. */
interface ChartModel {
  dots: ChartDot[];
  xTicks: ChartTick[];
  yTicks: ChartTick[];
  avgX: number;
  avgY: number;
  avgOrtg: number;
  avgDrtg: number;
  netZero: { x1: number; y1: number; x2: number; y2: number };
}

/** One-click "scouting" views: each is just a backend sort. */
interface QuickView {
  id: string;
  label: string;
  hint: string;
  sortBy: string;
  order: 'asc' | 'desc';
}

@Component({
  selector: 'lineups-summary-component',
  imports: [
    DecimalPipe,
    PercentPipe,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatPaginatorModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSliderModule,
    MatSortModule,
    MatTableModule,
    MatTooltipModule,
  ],
  templateUrl: './lineups-summary.component.html',
  styleUrl: './lineups-summary.component.scss',
})
export class LineupsSummaryComponent implements OnInit, AfterViewInit {
  private readonly lineupsService = inject(LineupsService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queries$ = new Subject<LineupQuery>();

  @ViewChild(MatPaginator) paginator!: MatPaginator;

  // ----- filter state (sent to the backend as query params) -----
  lineupSize = 5;
  teamId: string | null = null;
  playerId: string | null = null;
  minPossessions = 10;
  sortBy = 'net_rating';
  order: 'asc' | 'desc' = 'desc';
  quickView = 'overall';

  // ----- data -----
  teams: TeamOption[] = [];
  players: PlayerOption[] = [];
  readonly dataSource = new MatTableDataSource<Lineup>([]);
  loading = false;
  error = '';

  readonly lineupSizes = [5, 4, 3, 2, 1];

  // ----- chart -----
  readonly chartWidth = 760;
  readonly chartHeight = 420;
  readonly margin = { top: 20, right: 24, bottom: 48, left: 60 };
  readonly teamPalette = ['#007ac1', '#ef6c00', '#2e7d32'];
  chart: ChartModel | null = null;
  selectedKey: string | null = null;
  hoverKey: string | null = null;

  readonly quickViews: QuickView[] = [
    { id: 'overall', label: 'Best overall', hint: 'Highest net rating: outscoring opponents per 100 possessions', sortBy: 'net_rating', order: 'desc' },
    { id: 'glass', label: 'Win the glass', hint: 'Highest defensive rebound %: deny second chances to big, glass-crashing teams', sortBy: 'dreb_pct', order: 'desc' },
    { id: 'second-chance', label: 'Second chances', hint: 'Highest offensive rebound %: extra shots off our own misses', sortBy: 'oreb_pct', order: 'desc' },
    { id: 'ball-security', label: 'Ball security', hint: 'Lowest turnover %: fewest wasted possessions', sortBy: 'offensive_tov_pct', order: 'asc' },
    { id: 'defense', label: 'Lockdown D', hint: 'Lowest defensive rating: fewest points allowed per 100 possessions', sortBy: 'defensive_rating', order: 'asc' },
  ];

  readonly displayedColumns = [
    'players',
    'total_possessions',
    'net_rating',
    'offensive_rating',
    'defensive_rating',
    'plus_minus',
    'offensive_efg_pct',
    'defensive_efg_pct',
    'offensive_tov_pct',
    'defensive_tov_pct',
    'oreb_pct',
    'dreb_pct',
  ];

  /** Plain-English definitions shown as header tooltips. */
  readonly glossary: Record<string, string> = {
    total_possessions: 'Offensive + defensive possessions this lineup played together',
    net_rating: 'Offensive rating minus defensive rating. Positive = outscoring opponents',
    offensive_rating: 'Points scored per 100 offensive possessions',
    defensive_rating: 'Points allowed per 100 defensive possessions (lower is better)',
    plus_minus: 'Points scored minus points allowed',
    offensive_efg_pct: 'Effective FG%: (FGM + 0.5 × 3PM) / FGA. Credits 3s for their extra point',
    defensive_efg_pct: "Opponents' effective FG% against this lineup (lower is better)",
    offensive_tov_pct: 'Turnovers per offensive possession (lower is better)',
    defensive_tov_pct: 'Turnovers forced per defensive possession (higher is better)',
    oreb_pct: 'Share of our missed shots we rebounded',
    dreb_pct: "Share of opponents' missed shots we rebounded",
  };

  ngOnInit(): void {
    // switchMap cancels an in-flight request if filters change again, so results never arrive out of order
    this.queries$
      .pipe(
        switchMap((query) => this.lineupsService.getLineupsLeagueSummary(query)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ apiResponse }) => {
          this.dataSource.data = apiResponse;
          this.chart = this.buildChart(apiResponse);
          if (this.selectedKey && !apiResponse.some((r) => this.rowKey(r) === this.selectedKey)) {
            this.selectedKey = null;
          }
          this.loading = false;
          this.error = '';
          this.paginator?.firstPage();
          this.cdr.markForCheck();
        },
        error: () => {
          this.loading = false;
          this.error = 'Could not load lineups. Is the backend running?';
          this.cdr.markForCheck();
        },
      });

    this.loadTeamsAndPlayers();
    this.reload();
  }

  ngAfterViewInit(): void {
    this.dataSource.paginator = this.paginator;
  }

  /** 1-man lineups give us every player who actually played, plus their team. */
  private loadTeamsAndPlayers(): void {
    this.lineupsService.getLineupsLeagueSummary({ lineup_size: 1 }).subscribe({
      next: ({ apiResponse }) => {
        const teams = new Map<string, string>();
        this.players = apiResponse
          .map((row) => {
            teams.set(row.team_id, row.team_name);
            return { id: row.players[0].player_id, name: row.players[0].name, teamId: row.team_id };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        this.teams = [...teams].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
        this.chart = this.buildChart(this.dataSource.data); // recolor dots now that team order is known
        this.cdr.markForCheck();
      },
    });
  }

  get playerOptions(): PlayerOption[] {
    return this.teamId ? this.players.filter((p) => p.teamId === this.teamId) : this.players;
  }

  reload(): void {
    this.loading = true;
    this.queries$.next({
      lineup_size: this.lineupSize,
      team_id: this.teamId,
      player_id: this.playerId,
      min_possessions: this.minPossessions,
      sort_by: this.sortBy,
      order: this.order,
    });
  }

  onTeamChange(): void {
    // a player from another team can't appear in this team's lineups
    if (this.playerId && !this.playerOptions.some((p) => p.id === this.playerId)) {
      this.playerId = null;
    }
    this.reload();
  }

  onQuickView(id: string): void {
    const view = this.quickViews.find((v) => v.id === id);
    if (!view) return;
    this.sortBy = view.sortBy;
    this.order = view.order;
    this.reload();
  }

  /** Column header clicks sort on the server, using the backend's sort_by/order params. */
  onSortChange(sort: Sort): void {
    this.sortBy = sort.active;
    this.order = sort.direction === 'asc' ? 'asc' : 'desc';
    this.quickView = this.quickViews.find((v) => v.sortBy === this.sortBy && v.order === this.order)?.id ?? '';
    this.reload();
  }

  resetFilters(): void {
    this.lineupSize = 5;
    this.teamId = null;
    this.playerId = null;
    this.minPossessions = 10;
    this.onQuickView((this.quickView = 'overall'));
  }

  // ----- chart + selection -----

  rowKey(row: Lineup): string {
    return `${row.team_id}:${row.player_ids.join(',')}`;
  }

  get selected(): Lineup | undefined {
    return this.dataSource.data.find((r) => this.rowKey(r) === this.selectedKey);
  }

  teamColor(teamId: string): string {
    const index = this.teams.findIndex((t) => t.id === teamId);
    return this.teamPalette[(index < 0 ? 0 : index) % this.teamPalette.length];
  }

  /** Select a lineup from either the chart or the table, and jump the table to its page. */
  select(row: Lineup): void {
    const key = this.rowKey(row);
    this.selectedKey = this.selectedKey === key ? null : key;
    if (!this.selectedKey || !this.paginator) return;

    const index = this.dataSource.data.findIndex((r) => this.rowKey(r) === key);
    const pageIndex = Math.floor(index / this.paginator.pageSize);
    if (pageIndex !== this.paginator.pageIndex) {
      const previousPageIndex = this.paginator.pageIndex;
      this.paginator.pageIndex = pageIndex;
      this.paginator.page.emit({ pageIndex, previousPageIndex, pageSize: this.paginator.pageSize, length: this.dataSource.data.length });
    }
  }

  /**
   * Map every lineup to a dot: x = offensive rating (right is better),
   * y = defensive rating flipped so up is better, size = possessions played.
   * Crosshairs sit at the possession-weighted average of the lineups shown.
   */
  private buildChart(rows: Lineup[]): ChartModel | null {
    const plotted = rows.filter((r) => r.offensive_possessions > 0 && r.defensive_possessions > 0);
    if (!plotted.length) return null;

    const { top, right, bottom, left } = this.margin;
    const innerW = this.chartWidth - left - right;
    const innerH = this.chartHeight - top - bottom;

    // one shared, rounded domain for both axes so the "net = 0" diagonal is a true 45° line
    const values = plotted.flatMap((r) => [r.offensive_rating, r.defensive_rating]);
    const lo = Math.max(0, Math.floor((Math.min(...values) - 5) / 20) * 20);
    const hi = Math.ceil((Math.max(...values) + 5) / 20) * 20;
    const xScale = (v: number) => left + ((v - lo) / (hi - lo)) * innerW;
    const yScale = (v: number) => top + ((v - lo) / (hi - lo)) * innerH; // low DRtg (good) at the top

    const maxPoss = Math.max(...plotted.map((r) => r.total_possessions));
    const radius = (poss: number) => 4 + Math.sqrt(poss / maxPoss) * 10;

    const offPoss = plotted.reduce((sum, r) => sum + r.offensive_possessions, 0);
    const defPoss = plotted.reduce((sum, r) => sum + r.defensive_possessions, 0);
    const avgOrtg = (plotted.reduce((sum, r) => sum + r.offensive_points, 0) / offPoss) * 100;
    const avgDrtg = (plotted.reduce((sum, r) => sum + r.defensive_points, 0) / defPoss) * 100;

    const ticks: number[] = [];
    for (let v = lo; v <= hi; v += 20) ticks.push(v);

    const dots = plotted
      .map((row) => ({
        key: this.rowKey(row),
        x: xScale(row.offensive_rating),
        y: yScale(row.defensive_rating),
        r: radius(row.total_possessions),
        color: this.teamColor(row.team_id),
        label: `${this.lineupNames(row)} (${row.team_name})\nNet ${this.signed(row.net_rating)} · ORtg ${row.offensive_rating} · DRtg ${row.defensive_rating} · ${row.total_possessions} poss`,
        row,
      }))
      .sort((a, b) => b.r - a.r); // big dots first so small ones stay clickable on top

    return {
      dots,
      xTicks: ticks.map((value) => ({ value, pos: xScale(value) })),
      yTicks: ticks.map((value) => ({ value, pos: yScale(value) })),
      avgX: xScale(avgOrtg),
      avgY: yScale(avgDrtg),
      avgOrtg,
      avgDrtg,
      netZero: { x1: xScale(lo), y1: yScale(lo), x2: xScale(hi), y2: yScale(hi) },
    };
  }

  // ----- display helpers -----

  lineupNames(row: Lineup): string {
    return row.players.map((p) => p.name).join(' · ');
  }

  signed(value: number): string {
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
  }

  /** Green for positive net rating, red for negative; stronger color = bigger margin (capped at ±30). */
  netColor(value: number): string {
    const strength = Math.min(Math.abs(value), 30) / 30;
    const alpha = (0.12 + strength * 0.5).toFixed(2);
    return value >= 0 ? `rgba(46, 160, 67, ${alpha})` : `rgba(218, 54, 51, ${alpha})`;
  }

  trackByLineup = (_: number, row: Lineup) => this.rowKey(row);
}
