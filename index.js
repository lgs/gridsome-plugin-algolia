module.exports = function (api, options) {
  const algoliasearch = require('algoliasearch');
  const chunk = require('lodash.chunk');

  /**
   * give back the same thing as this was called with.
   *
   * @param {any} item what to keep the same
   */
  const defaultTransformer = (item) => {
    return {
      objectID: item.id,
      title: item.title,
      slug: item.slug,
      modified: item.modified,
    };
  }

  const indexHits = {}

  /**
   * Fetches all items for the current index from Algolia
   *
   * @param {AlgoliaIndex} index eg. client.initIndex('your_index_name');
   * @param {Array<String>} attributesToRetrieve eg. ['modified', 'slug']
   */
  function fetchAlgoliaObjects(index, attributesToRetrieve) {
    return new Promise((resolve, reject) => {
      /* Check if we havn't already fetched this index */
      if (indexHits[index.indexName]) return resolve(indexHits[index.indexName])

      const browser = index.browseAll('', { attributesToRetrieve: ['modified'] });
      const hits = {};

      browser.on('result', (content) => {
        if (Array.isArray(content.hits)) {
          content.hits.forEach(hit => {
            hits[hit.objectID] = hit
          })
        }
      });
      browser.on('end', () => {
        indexHits[index.indexName] = hits
        resolve(hits)
      });
      browser.on('error', (err) => reject(err) );
    });
  }

  api.afterBuild(async ({ store, config }) => {
    if (!config.siteUrl) {
      throw new Error(`Sitemap plugin is missing a required siteUrl config.`)
    }

    const started = Date.now()

    const { appId, apiKey, collections, chunkSize = 1000, enablePartialUpdates = false } = options

    const jobs = collections.map(async (
      { indexName, itemFormatter = defaultTransformer, contentTypeName, matchFields = ['modified'] },
      cIndex
    ) => {
      if (!contentTypeName) throw `Algolia failed collection #${cIndex}: contentTypeName required`;

      if (!Array.isArray(matchFields) || !matchFields.length) throw `Algolia failed ${cIndex}: matchFields required array of strings`;

      /* Use to keep track of what to remove afterwards */
      if (!indexState[indexName]) indexState[indexName] = {
        index: client.initIndex(indexName),
        toRemove: {}
      }
      const currentIndexState = indexState[indexName];

      const { index } = currentIndexState;
      /* Use temp index if main index already exists */
      let useTempIndex = false
      const indexToUse = await (async (_index) => {
        if (!enablePartialUpdates) {
          if (useTempIndex = await indexExists(_index)) {
            const tmpIndex = client.initIndex(`${indexName}_tmp`);
            await scopedCopyIndex(client, _index, tmpIndex);
            return tmpIndex;
          }
        }
        return _index
      })(index)

      console.log(`Algolia collection #${i}: getting ${contentTypeName}`);

      const { collection } = store.getContentType(contentTypeName)

      const items = collection.data.map(itemFormatter)
      if (items.length > 0 && !items[0].objectID) {
        throw `Algolia failed collection #${cIndex}. Query results do not have 'objectID' key`;
      }

      console.log(`Algolia collection #${i}: items in collection ${Object.keys(items).length}`);

      let hasChanged = items;
      if (enablePartialUpdates) {
        console.log(`Algolia collection #${i}: starting Partial updates`);

        const algoliaItems = await fetchAlgoliaObjects(indexToUse, matchFields);

        const results = Object.keys(algoliaItems).length
        console.log(`Algolia collection #${i}: found ${results} existing items`);

        if (results) {
          hasChanged = items.filter(curObj => {
            const {objectID} = curObj
            let extObj = algoliaItems[objectID]

            /* The object exists so we don't need to remove it from Algolia */
            delete(algoliaItems[objectID]);
            delete(currentIndexState.toRemove[objectID])

            if (!extObj) return true;

            return !!matchFields.find(field => extObj[field] !== curObj[field]);
          });

          Object.keys(algoliaItems).forEach(({ objectID }) => currentIndexState.toRemove[objectID] = true)
        }

        console.log(`Algolia collection #${i}: Partial updates – [insert/update: ${hasChanged.length}, total: ${items.length}]`);
      }

      const chunks = chunk(hasChanged, chunkSize);

      console.log(`Algolia collection #${i}: splitting in ${chunks.length} jobs`);

      /* Add changed / new items */
      const chunkJobs = chunks.map(async function(chunked) {
        const { taskID } = await indexToUse.addObjects(chunked);
        return indexToUse.waitTask(taskID);
      });

      await Promise.all(chunkJobs);

      if (useTempIndex) {
        console.log(`Algolia collection #${i}: moving copied index to main index`);
        return moveIndex(client, indexToUse, index);
      }
    });

    try {
      await Promise.all(jobs)
      if (enablePartialUpdates) {
        /* Execute once per index */
        /* This allows multiple queries to overlap */
        const cleanup = Object.keys(indexState).map(async function(indexName) {
          const state = indexState[indexName];
          const isRemoved = Object.keys(state.toRemove);

          if (isRemoved.length) {
            console.log(`Algolia: deleting ${isRemoved.length} items from ${indexName} index`);
            const { taskID } = await state.index.deleteObjects(isRemoved);
            return state.index.waitTask(taskID);
          }
        })

        await Promise.all(cleanup);
      }
    } catch (err) {
      throw (`Algolia failed collection #${cIndex}`, err);
    }

    console.log(`Finished indexing to Algolia in ${Date.now() - started}ms`);
  })
}

/**
 * Copy the settings, synonyms, and rules of the source index to the target index
 * @param client
 * @param sourceIndex
 * @param targetIndex
 * @return {Promise}
 */
async function scopedCopyIndex(client, sourceIndex, targetIndex) {
  const { taskID } = await client.copyIndex(
    sourceIndex.indexName,
    targetIndex.indexName,
    ['settings', 'synonyms', 'rules']
  );
  return targetIndex.waitTask(taskID);
}

/**
 * moves the source index to the target index
 * @param client
 * @param sourceIndex
 * @param targetIndex
 * @return {Promise}
 */
async function moveIndex(client, sourceIndex, targetIndex) {
  const { taskID } = await client.moveIndex(
    sourceIndex.indexName,
    targetIndex.indexName
  );
  return targetIndex.waitTask(taskID);
}

/**
 * Does an Algolia index exist already
 *
 * @param index
 */
async function indexExists(index) {
  try {
    const { nbHits } = await index.search();
    return nbHits > 0;
  } catch (e) {
    return false;
  }
}