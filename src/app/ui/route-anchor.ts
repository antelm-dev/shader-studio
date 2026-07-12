import { ChangeDetectionStrategy, Component } from '@angular/core';

/** The application shell is bootstrapped once; routed state is coordinated by App. */
@Component({
  selector: 'app-route-anchor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class RouteAnchor {}
