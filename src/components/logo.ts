import type { ColorTheme } from "@/components/theme-provider";

import logoPurple from "@/assets/postgly-logo.png";
import logoBlue from "@/assets/postgly-logo-blue.png";
import logoRed from "@/assets/postgly-logo-red.png";
import logoPink from "@/assets/postgly-logo-pink.png";
import logoGreen from "@/assets/postgly-logo-green.png";
import logoOrange from "@/assets/postgly-logo-orange.png";
import logoYellow from "@/assets/postgly-logo-yellow.png";

/** Maps the active color palette to its matching brand logo. `purple` is
 *  the default palette and uses the unsuffixed asset. */
const LOGO_BY_COLOR: Record<ColorTheme, string> = {
  purple: logoPurple,
  blue: logoBlue,
  red: logoRed,
  pink: logoPink,
  green: logoGreen,
  orange: logoOrange,
  yellow: logoYellow,
};

/** Returns the logo URL for the given color palette. */
export function logoForColor(color: ColorTheme): string {
  return LOGO_BY_COLOR[color] ?? logoPurple;
}
