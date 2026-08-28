import type {MyDocument} from '@appManagers/appDocsManager';
import animationIntersector, {AnimationItemGroup} from '@components/animationIntersector';
import Scrollable from '@components/scrollable';
import deferredPromise, {CancellablePromise} from '@helpers/cancellablePromise';
import {doubleRaf} from '@helpers/schedulers';
import {AppManagers} from '@lib/managers';
import rootScope from '@lib/rootScope';
import LazyLoadQueueRepeat2 from '@components/lazyLoadQueueRepeat2';
import wrapVideo from '@components/wrappers/video';
import noop from '@helpers/noop';
import {MiddlewareHelper, getMiddleware} from '@helpers/middleware';
import positionElementByIndex from '@helpers/dom/positionElementByIndex';
import {Message, PhotoSize} from '@layer';

type GifsMasonryAddOptions = {
  element?: HTMLElement,
  key?: DocId | string,
  mediaClass?: string,
  message?: Message.message,
  noLiveInfo?: boolean,
  noInfo?: boolean,
  photoSize?: PhotoSize,
  useProvidedDocument?: boolean
};

type GifsMasonryItem = {
  doc?: MyDocument,
  mediaClass?: string,
  message?: Message.message,
  noLiveInfo: boolean,
  noInfo: boolean,
  photoSize?: PhotoSize
};

export default class GifsMasonry {
  public lazyLoadQueue: LazyLoadQueueRepeat2;
  private scrollPromise: CancellablePromise<void> = Promise.resolve();
  private timeout: number = 0;
  private managers: AppManagers;
  private middlewareHelper: MiddlewareHelper;
  private map: Map<DocId | string, HTMLElement>;
  private items: WeakMap<HTMLElement, GifsMasonryItem>;

  constructor(
    private element: HTMLElement,
    private group: AnimationItemGroup,
    private scrollable: Scrollable,
    attach = true
  ) {
    this.managers = rootScope.managers;
    this.middlewareHelper = getMiddleware();
    this.map = new Map();
    this.items = new WeakMap();

    this.lazyLoadQueue = new LazyLoadQueueRepeat2(undefined, ({target, visible}) => {
      if(visible) {
        this.processVisibleDiv(target);
      } else {
        this.processInvisibleDiv(target);
      }
    });

    if(attach) {
      this.attach();
    }
  }

  private onScroll = () => {
    if(this.timeout) {
      clearTimeout(this.timeout);
    } else {
      this.scrollPromise = deferredPromise<void>();
      // animationIntersector.checkAnimations(true, group);
    }

    this.timeout = window.setTimeout(() => {
      this.timeout = 0;
      this.scrollPromise.resolve();
      // animationIntersector.checkAnimations(false, group);
    }, 150);
  };

  public attach() {
    this.scrollable.container.addEventListener('scroll', this.onScroll);
  }

  public detach() {
    this.clear();
    this.scrollable.container.removeEventListener('scroll', this.onScroll);
    this.middlewareHelper.destroy();
  }

  public clear() {
    this.lazyLoadQueue.clear();
  }

  public setActive(active: boolean) {
    if(active) {
      this.lazyLoadQueue.unlockAndRefresh();
      return;
    }

    this.lazyLoadQueue.lock();
    for(const div of this.lazyLoadQueue.intersector.getVisible()) {
      this.processInvisibleDiv(div, true);
    }
    this.lazyLoadQueue.intersector.clearVisible();
  }

  private processVisibleDiv(div: HTMLElement) {
    const video = div.querySelector('video');
    if(video) {
      return;
    }

    const load = () => {
      const item = this.items.get(div);
      const promise = Promise.all([item?.doc || this.managers.appDocsManager.getDoc(div.dataset.docId), this.scrollPromise]).then(async([doc]) => {
        if(!this.lazyLoadQueue.intersector.isVisible(div)) {
          this.processInvisibleDiv(div);
          return;
        }

        div.middlewareHelper.clean();
        const middleware = div.middlewareHelper.get().create().get();
        const res = await wrapVideo({
          doc,
          container: div as HTMLDivElement,
          lazyLoadQueue: null,
          // lazyLoadQueue: EmoticonsDropdown.lazyLoadQueue,
          group: this.group,
          noInfo: item?.noLiveInfo || (item?.noInfo ?? true),
          noPreview: true,
          middleware,
          message: item?.message,
          photoSize: item?.photoSize
        });
        item?.mediaClass && res.video?.classList.add(item.mediaClass);

        const promise = res.loadPromise;
        promise.finally(() => {
          middleware.onDestroy(() => {
            res.video?.remove();
          });

          if(!middleware() || !this.lazyLoadQueue.intersector.isVisible(div)) {
            this.processInvisibleDiv(div);
            return;
          }

          const thumb = div.querySelector('img, canvas');
          thumb && thumb.classList.add('hide');
        });

        return promise;
      });

      return promise;
    };

    // return load();

    this.lazyLoadQueue.push({div, load});
  }

  public processInvisibleDiv = (div: HTMLElement, force = false) => {
    return this.scrollPromise.then(async() => {
      // return;

      if(!force && this.lazyLoadQueue.intersector.isVisible(div)) {
        return;
      }

      const thumb = div.querySelector('img, canvas');

      if(thumb) {
        thumb.classList.remove('hide');
        await doubleRaf();
      }

      if(!force && this.lazyLoadQueue.intersector.isVisible(div)) {
        return;
      }

      div.middlewareHelper.clean();
    });
  };

  public addBatch(docs: MyDocument[]) {
    docs.forEach((doc) => this.add(doc));
  }

  public update(docs: MyDocument[]) {
    for(const [docId] of this.map) {
      if(!docs.some((doc) => doc.id === docId)) {
        this.delete(docId);
      }
    }

    this.addBatch(docs);
    for(let i = 0, length = docs.length; i < length; ++i) {
      const element = this.map.get(docs[i].id);
      positionElementByIndex(element, this.element, i);
    }
  }

  public add(doc: MyDocument, appendTo = this.element, options: GifsMasonryAddOptions = {}) {
    const key = options.key ?? doc.id;
    if(this.map.has(key)) {
      return Promise.resolve(undefined);
    }

    const div = options.element || document.createElement('div');
    div.classList.add('gif', 'grid-item'/* , 'fade-in-transition' */);
    // div.style.opacity = '0';
    div.dataset.docId = '' + doc.id;
    div.middlewareHelper = this.middlewareHelper.get().create();
    this.map.set(key, div);
    this.items.set(div, {
      doc: options.useProvidedDocument ? doc : undefined,
      mediaClass: options.mediaClass,
      message: options.message,
      noLiveInfo: options.noLiveInfo ?? false,
      noInfo: options.noInfo ?? true,
      photoSize: options.photoSize
    });

    appendTo.append(div);

    this.lazyLoadQueue.observe({div, load: noop as any});

    // let preloader = new ProgressivePreloader(div);

    const promise = wrapVideo({
      doc,
      container: div as HTMLDivElement,
      lazyLoadQueue: null,
      noInfo: options.noInfo ?? true,
      onlyPreview: true,
      middleware: div.middlewareHelper.get(),
      message: options.message,
      photoSize: options.photoSize
    });
    promise.then((result) => {
      if(!options.mediaClass) {
        return;
      }

      [result.thumb?.images.thumb, result.thumb?.images.full].filter(Boolean).forEach((image) => {
        image.classList.add(options.mediaClass);
      });
    });
    return promise;
  }

  public delete(docId: DocId) {
    const div = this.map.get(docId);
    if(div) {
      div.remove();
      div.middlewareHelper.destroy();
      this.map.delete(docId);
    }
  }
}
