export function buildEvidenceReviewGovernance() {
  return {
    reviewerComments: {
      label: "Private workspace note",
      publicVerifyIncluded: false,
      reportIncluded: false,
      verificationPackageIncluded: false,
      reviewerOnly: true,
    },
    legalNotes: {
      label: "Internal legal note",
      publicVerifyIncluded: false,
      reportIncluded: false,
      verificationPackageIncluded: false,
      reviewerOnly: true,
    },
    annotations: {
      label: "Internal reviewer annotation",
      publicVerifyIncluded: false,
      reportIncluded: false,
      verificationPackageIncluded: false,
      reviewerOnly: true,
    },
    aiCategorization: {
      label: "Internal advisory categorization",
      publicVerifyIncluded: false,
      reportIncluded: false,
      verificationPackageIncluded: false,
      reviewerOnly: true,
    },
  };
}
