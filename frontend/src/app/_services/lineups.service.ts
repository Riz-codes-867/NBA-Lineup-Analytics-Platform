import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { BaseService } from './base.service';
import { Lineup, LineupQuery } from './lineup.models';

@Injectable({ providedIn: 'root' })
export class LineupsService extends BaseService {
  constructor(protected override http: HttpClient) {
    super(http);
  }

  private buildQueryParams(queryParams: Record<string, string | number>): HttpParams {
    return Object.entries(queryParams).reduce(
      (params, [key, value]) => params.set(key, String(value)),
      new HttpParams(),
    );
  }

  private buildDisplayedEndpointWithParams(
    endpoint: string,
    queryParams: Record<string, string | number>,
  ): string {
    const queryString = new URLSearchParams(
      Object.entries(queryParams).map(([key, value]) => [key, String(value)]),
    ).toString();
    return queryString ? `${endpoint}?${queryString}` : endpoint;
  }

  /**
   * Fetch lineup summaries. Accepts either a lineup size (used by the API inspector tab)
   * or a full query object with filters and sorting (used by the Lineup Explorer).
   */
  getLineupsLeagueSummary(query: number | LineupQuery = 5): Observable<{
    endpoint: string;
    apiResponse: Lineup[];
  }> {
    const endpoint = `${this.baseUrl}/lineups`;
    const options: LineupQuery = typeof query === 'number' ? { lineup_size: query } : query;

    // drop empty values so the backend falls back to its defaults
    const queryParams: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null && value !== '') {
        queryParams[key] = value as string | number;
      }
    }

    const params = this.buildQueryParams(queryParams);
    const displayedEndpointWithParams = this.buildDisplayedEndpointWithParams(endpoint, queryParams);

    return this.get(endpoint, params).pipe(
      map((data) => ({
        endpoint: displayedEndpointWithParams,
        apiResponse: data as Lineup[],
      })),
    );
  }
}
