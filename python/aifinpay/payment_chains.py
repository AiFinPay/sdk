"""Independent native, gas-family and chain/address decimal pins.

Mirrors node/src/paymentChains.ts. Descriptors do not activate production.
Unknown tokens never inherit six decimals; generated deployments still select
allowed addresses. BNB/Robinhood decimal read evidence:2026-10-04.
"""
from typing import Optional

PAYMENT_CHAINS = {
    "polygon": {
        "chainId": 137,
        "label": "Polygon",
        "native": "POL",
        "gasModel": "evm",
        "defaultRpc": "https://polygon.drpc.org",
        "coingeckoId": "polygon-ecosystem-token",
        "maxSaneUsd": 1000
    },
    "base": {
        "chainId": 8453,
        "label": "Base",
        "native": "ETH",
        "gasModel": "op",
        "defaultRpc": "https://mainnet.base.org",
        "coingeckoId": "ethereum",
        "maxSaneUsd": 100000
    },
    "optimism": {
        "chainId": 10,
        "label": "Optimism",
        "native": "ETH",
        "gasModel": "op",
        "defaultRpc": "https://mainnet.optimism.io",
        "coingeckoId": "ethereum",
        "maxSaneUsd": 100000
    },
    "arbitrum": {
        "chainId": 42161,
        "label": "Arbitrum",
        "native": "ETH",
        "gasModel": "nitro",
        "defaultRpc": "https://arb1.arbitrum.io/rpc",
        "coingeckoId": "ethereum",
        "maxSaneUsd": 100000
    },
    "avalanche": {
        "chainId": 43114,
        "label": "Avalanche",
        "native": "AVAX",
        "gasModel": "evm",
        "defaultRpc": "https://api.avax.network/ext/bc/C/rpc",
        "coingeckoId": "avalanche-2",
        "maxSaneUsd": 100000
    },
    "bnb": {
        "chainId": 56,
        "label": "BNB Chain",
        "native": "BNB",
        "gasModel": "evm",
        "defaultRpc": "https://bsc-dataseed1.bnbchain.org",
        "coingeckoId": "binancecoin",
        "maxSaneUsd": 100000
    },
    "unichain": {
        "chainId": 130,
        "label": "Unichain",
        "native": "ETH",
        "gasModel": "op",
        "defaultRpc": "https://mainnet.unichain.org",
        "coingeckoId": "ethereum",
        "maxSaneUsd": 100000
    },
    "xrplevm": {
        "chainId": 1440000,
        "label": "XRPL EVM",
        "native": "XRP",
        "gasModel": "evm",
        "defaultRpc": "https://rpc.xrplevm.org",
        "coingeckoId": "ripple",
        "maxSaneUsd": 1000
    },
    "robinhood": {
        "chainId": 4663,
        "label": "Robinhood",
        "native": "ETH",
        "gasModel": "nitro",
        "defaultRpc": "https://rpc.mainnet.chain.robinhood.com",
        "coingeckoId": "ethereum",
        "maxSaneUsd": 100000
    }
}

TOKEN_DECIMALS = {
    "polygon": {
        "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6,
        "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": 6
    },
    "base": {
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6
    },
    "optimism": {
        "0x0b2c639c533813f4aa9d7837caf62653d097ff85": 6
    },
    "arbitrum": {
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6
    },
    "avalanche": {
        "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": 6,
        "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": 6
    },
    "bnb": {
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 18,
        "0x55d398326f99059ff775485246999027b3197955": 18
    },
    "unichain": {
        "0x078d782b760474a361dda0af3839290b0ef57ad6": 6
    },
    "robinhood": {
        "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": 18,
        "0x5fc5360d0400a0fd4f2af552add042d716f1d168": 6
    },
    "amoy": {
        "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582": 6
    }
}


def pinned_token_decimals(chain: str, token: str) -> Optional[int]:
    return TOKEN_DECIMALS.get(chain, {}).get(token.lower())
