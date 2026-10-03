# Contributing to Rapier JXL

Rapier JXL is an MIT-licensed JPEG XL encoder. Anyone can contribute, and there is no agreement to sign: by opening a
pull request you offer your change under the same MIT licence as the rest. The maintainers read it, run the byte cases
and the size ledger, and merge what earns its bytes.

- **A picture that encodes wrong, or a decoder that refuses the output:** open an issue with the smallest picture that
  shows it, or a pull request that adds it to the cases red first.
- **A smaller or faster path:** measure it alone against the cases in `sizes.json` and say the numbers in the pull
  request; a change lands with its measurement, not a claim.
- **A port, a binding, a tool that uses it:** welcome as its own project; link it from an issue and it goes in the
  README.

Be specific, be kind, and say if an AI tool helped. The editor that carries this encoder is at
[github.com/jackskip22/rapier](https://github.com/jackskip22/rapier).
