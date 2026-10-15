// Ported from @serenityjs/core@0.8.21
// https://github.com/SerenityJS/serenity/blob/eb6ac9734aeae0d3f4ac441c222804e1af6a6b4d/packages/core/src/types/entity/title-display-options.ts

export interface TitleDisplayOptions {
  /**
   * The time it takes for the title to fade in.
   */
  fadeInDuration?: number;

  /**
   * The time the title should stay on the screen.
   */
  stayDuration?: number;

  /**
   * The time it takes for the title to fade out.
   */
  fadeOutDuration?: number;

  /**
   * The subtitle to display.
   */
  subtitle?: string;
}
