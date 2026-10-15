import { SetTitlePacket, TitleType, TextPacket, TextVariantType, TextVariant, TextType, ToastRequestPacket } from '@serenityjs/protocol';
import type { Player } from './player';
import type { TitleDisplayOptions } from '../types';

export class ScreenDisplay {
  constructor(protected readonly player: Player) {}

  /**
   * Set the title of the player.
   * @param text The text to display.
   * @param options The additional options for the title.
   */
  public setTitle(text: string, options?: TitleDisplayOptions): void {
    // Create a new SetTitlePacket.
    const packet = new SetTitlePacket();
    packet.type = TitleType.Title;
    packet.text = text;
    packet.fadeInTime = options?.fadeInDuration ?? 20;
    packet.stayTime = options?.stayDuration ?? 60;
    packet.fadeOutTime = options?.fadeOutDuration ?? 20;
    packet.xuid = this.player.xuid;
    packet.platformOnlineId = String();
    packet.filteredText = text; // TODO: Filter the text.

    // Update the subtitle if it is provided
    if (options?.subtitle) this.updateSubtitle(options.subtitle, options);

    // Send the packet to the player.
    this.player.send(packet);
  }

  /**
   * Set the action bar of the player.
   * @param text The text to display.
   * @param options The additional options for the action bar.
   */
  public setActionBar(text: string, options?: TitleDisplayOptions): void {
    // Create a new SetTitlePacket.
    const packet = new SetTitlePacket();
    packet.type = TitleType.Actionbar;
    packet.text = text;
    packet.fadeInTime = options?.fadeInDuration ?? 20;
    packet.stayTime = options?.stayDuration ?? 60;
    packet.fadeOutTime = options?.fadeOutDuration ?? 20;
    packet.xuid = this.player.xuid;
    packet.platformOnlineId = String();
    packet.filteredText = text; // TODO: Filter the text.

    // Send the packet to the player.
    this.player.send(packet);
  }

  /**
   * Set the jukebox popup of the player.
   * @param text The text to display.
   */
  public setJukeboxPopup(text: string): void {
    // Create a new TextPacket.
    const packet = new TextPacket();
    packet.isLocalized = true;
    packet.variantType = TextVariantType.MessageAndParams;
    packet.variant = new TextVariant(text, TextType.JukeboxPopup, "", []);
    packet.xuid = "";
    packet.platformChatId = "";

    // Send the packet to the player.
    this.player.send(packet);
  }

  /**
   * Set the tooltip text of the player.
   * @param text The text to display.
   */
  public setToolTip(text: string): void {
    // Create a new TextPacket.
    const packet = new TextPacket();
    packet.isLocalized = true;
    packet.variantType = TextVariantType.MessageOnly;
    packet.variant = new TextVariant(text, TextType.Tip);
    packet.xuid = "";
    packet.platformChatId = "";

    // Send the packet to the player.
    this.player.send(packet);
  }

  /**
   * Set the toast of the player;
   * @param title The title of the toast.
   * @param message The text to display.
   */
  public setToast(title: string, text: string): void {
    // Create a new Toast Packet
    const packet = new ToastRequestPacket();
    packet.title = title;
    packet.message = text;

    // Send the packet to the player.
    this.player.send(packet);
  }

  /**
   * Update the subtitle for the title of the player.
   * @param text The text to display.
   * @param options The additional options for the subtitle.
   */
  public updateSubtitle(text: string, options?: TitleDisplayOptions): void {
    // Create a new SetTitlePacket.
    const packet = new SetTitlePacket();
    packet.type = TitleType.Subtitle;
    packet.text = text;
    packet.fadeInTime = options?.fadeInDuration ?? 20;
    packet.stayTime = options?.stayDuration ?? 60;
    packet.fadeOutTime = options?.fadeOutDuration ?? 20;
    packet.xuid = this.player.xuid;
    packet.platformOnlineId = String();
    packet.filteredText = text; // TODO: Filter the text.

    // Send the packet to the player.
    this.player.send(packet);
  }

  /**
   * Clear the title of the player.
   */
  public clearTitle(): void {
    // Create a new SetTitlePacket.
    const packet = new SetTitlePacket();
    packet.type = TitleType.Clear;
    packet.text = String();
    packet.fadeInTime = 0;
    packet.stayTime = 0;
    packet.fadeOutTime = 0;
    packet.xuid = this.player.xuid;
    packet.platformOnlineId = String();
    packet.filteredText = String(); // TODO: Filter the text.

    // Send the packet to the player.
    this.player.send(packet);
  }
}
