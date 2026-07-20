import { Routes } from '@angular/router';
import { RouteAnchor } from './ui/layout/route-anchor';

export const routes: Routes = [
  { path: '', component: RouteAnchor },
  { path: 'shaders/:id', component: RouteAnchor },
  { path: '**', component: RouteAnchor },
];
