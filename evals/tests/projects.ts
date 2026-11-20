// The brief's viewports and color schemes, shared by the behavior tests and
// the runner's screenshots. Mobile keeps the Pixel 7 profile (touch, mobile
// user agent) at the brief's 390 × 844.
import { devices, type Project } from '@playwright/test';

export const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
export const mobile = { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } };

export const PROJECTS = [
  { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
  { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
  { name: 'mobile-light', use: { ...mobile, colorScheme: 'light' } },
  { name: 'mobile-dark', use: { ...mobile, colorScheme: 'dark' } },
] as const satisfies Project[];

export type ProjectName = (typeof PROJECTS)[number]['name'];
