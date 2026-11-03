import {createHash} from 'node:crypto';

/** Keep prior code identities across feedback imports, independent of labels and scores. */
export function createArtifactRegistry(field) {
  const identities = new Set();
  const identityOf = proposal => {
    const artifact = proposal[field];
    return createHash('sha256').update(typeof artifact === 'string' ? artifact : JSON.stringify(artifact)).digest('hex');
  };
  return {
    remember(proposal) { identities.add(identityOf(proposal)); },
    rememberHistory(records) {
      for (const record of records)
        if (record.proposal && Object.hasOwn(record.proposal, field)) this.remember(record.proposal);
    },
    assertNovel(proposal) {
      const identity = identityOf(proposal);
      if (identities.has(identity))
        throw Error('Identical artifact was already evaluated; use recorded evidence to make a substantive change');
      return identity;
    },
  };
}
