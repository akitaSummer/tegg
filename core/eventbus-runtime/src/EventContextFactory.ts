import { AccessLevel, SingletonProto } from '@eggjs/core-decorator';
import { EggContext } from '@eggjs/tegg-runtime';

export type ContextCreator = (parentContext?: EggContext) => EggContext;

@SingletonProto({
  accessLevel: AccessLevel.PUBLIC,
})
export class EventContextFactory {
  private creator: ContextCreator;

  createContext(parentContext?: EggContext): EggContext {
    return this.creator(parentContext);
  }

  registerContextCreator(creator: ContextCreator) {
    this.creator = creator;
  }
}
