import { Module, type DynamicModule } from '@nestjs/common';

import { CapabilitiesController, PublicationsController } from './publications.controller';

@Module({})
export class PublicationsModule {
  /**
   * `capabilities` is always there, so the web app can ask whether Explore
   * exists at all; the publication routes only when it does.
   */
  static register({ exploreOn }: { exploreOn: boolean }): DynamicModule {
    return {
      module: PublicationsModule,
      controllers: [CapabilitiesController, ...(exploreOn ? [PublicationsController] : [])],
    };
  }
}
