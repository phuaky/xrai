import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(import.meta.dir, '../extension/content/youtube/detector.js'), 'utf8');

function loadDetector() {
  return new Function(source + '\nreturn YtraiDetector;')();
}

describe('YtraiDetector metadata extraction', () => {
  it('reads the channel from current yt-content-metadata-view-model cards', () => {
    document.body.innerHTML = `
      <ytd-rich-item-renderer>
        <h3><a href="/watch?v=abc1234">A useful video</a></h3>
        <yt-content-metadata-view-model>
          <span class="ytContentMetadataViewModelMetadataText ytContentMetadataViewModelMetadataTextLastPart">Akira The Don</span>
          <span class="ytContentMetadataViewModelMetadataText">1.6K views</span>
          <span class="ytContentMetadataViewModelMetadataText">2 days ago</span>
        </yt-content-metadata-view-model>
      </ytd-rich-item-renderer>`;
    const card = document.querySelector('ytd-rich-item-renderer');
    expect(loadDetector()._extractChannel(card)).toBe('Akira The Don');
  });

  it('retains the legacy ytd-channel-name path', () => {
    document.body.innerHTML = `
      <ytd-rich-item-renderer>
        <ytd-channel-name><a><span id="text">Bonobo - Topic</span></a></ytd-channel-name>
      </ytd-rich-item-renderer>`;
    const card = document.querySelector('ytd-rich-item-renderer');
    expect(loadDetector()._extractChannel(card)).toBe('Bonobo - Topic');
  });

  it('does not mistake views or age for a channel', () => {
    document.body.innerHTML = `
      <ytd-rich-item-renderer>
        <yt-content-metadata-view-model>
          <span class="ytContentMetadataViewModelMetadataText">82K views</span>
          <span class="ytContentMetadataViewModelMetadataText">4 days ago</span>
        </yt-content-metadata-view-model>
      </ytd-rich-item-renderer>`;
    const card = document.querySelector('ytd-rich-item-renderer');
    expect(loadDetector()._extractChannel(card)).toBe('');
  });
});
