import 'core-js/stable'
import 'regenerator-runtime/runtime'
import Aragon, { events } from '@aragon/api'
import { first } from 'rxjs/operators'
import tmAbi from './abi/tokenManager.json'
import { requestStatus } from './lib/constants'
import {
  tokenDataFallback,
  getTokenSymbol,
  getTokenName,
  getTokenDecimals,
  ETHER_TOKEN_FAKE_ADDRESS,
} from './lib/token-utils'

const app = new Aragon()

const ETHER_DATA = {
  decimals: 18,
  name: 'Ether',
  symbol: 'ETH',
}

app
  .call('getTokenManagers')
  .subscribe(initialize, (err) =>
    console.error(`Could not start background script execution due to the contract not loading token: ${err}`)
  )

async function initialize(tokenManagerAddresses) {
  let tokens = []
  let tmContracts = []
  const network = await app
    .network()
    .pipe(first())
    .toPromise()
  for (let tokenManager of tokenManagerAddresses) {
    tmContracts.push(app.external(tokenManager, tmAbi))
  }
  tokens = await app.call('getAcceptedDepositTokens').toPromise()

  const settings = {
    network,
  }
  return createStore(tmContracts, tokens, settings)
}

async function createStore(tokenManagerContracts, tokens, settings) {
  return app.store(
    (state, { event, returnValues, blockNumber }) => {
      let nextState = {
        ...state,
      }

      switch (event) {
        case events.ACCOUNTS_TRIGGER:
          return updateConnectedAccount(nextState, returnValues)
        case events.SYNC_STATUS_SYNCING:
          return { ...nextState, isSyncing: true }
        case events.SYNC_STATUS_SYNCED:
          return { ...nextState, isSyncing: false }
        case 'TokenRequestCreated':
          return newTokenRequest(nextState, returnValues, settings, blockNumber)
        case 'TokenRequestRefunded':
          return requestRefunded(nextState, returnValues)
        case 'TokenRequestFinalised':
          return requestFinalised(nextState, returnValues)
        default:
          return state
      }
    },
    {
      init: initializeState(tokenManagerContracts, tokens, settings),
    }
  )
}

/***********************
 *                     *
 *   Event Handlers    *
 *                     *
 ***********************/

function initializeState(tokenManagerContracts, tokens, settings) {
  return async (cachedState) => {
    try {
      const orgTokens = []
      for (let tokenManagerContract of tokenManagerContracts) {
        const minimeAddress = await tokenManagerContract.token().toPromise()
        const token = await getTokenData(minimeAddress, settings)
        token && app.indentify(`token-request ${token.symbol}`)
        orgTokens.push(token)
      }
      const acceptedTokens = await getAcceptedTokens(tokens, settings)
      tokens.includes(ETHER_TOKEN_FAKE_ADDRESS) &&
        acceptedTokens.unshift({
          ...ETHER_DATA,
          address: ETHER_TOKEN_FAKE_ADDRESS,
        })
      return {
        ...cachedState,
        isSyncing: true,
        orgTokens,
        acceptedTokens,
      }
    } catch (error) {
      console.error('Error initializing state: ', error)
    }
  }
}

const getAcceptedTokens = async (tokens, settings) => {
  const promises = tokens
    .filter(token => token != ETHER_TOKEN_FAKE_ADDRESS)
    .map(tokenAddress => getTokenData(tokenAddress, settings))
  return Promise.all(promises)
}

async function updateConnectedAccount(state, { account }) {
  return {
    ...state,
    account,
  }
}

async function newTokenRequest(
  state,
  { requestId, requesterAddress, depositToken, depositAmount, requestToken, requestAmount, requestTokenId, reference },
  settings,
  blockNumber
) {
  try {
    const { requests = [] } = state
    const { decimals: depositDecimals, name: depositName, symbol: depositSymbol } =
      depositToken === ETHER_TOKEN_FAKE_ADDRESS ? ETHER_DATA : await getTokenData(depositToken, settings)
    const { decimals: requestDecimals, name: requestName, symbol: requestSymbol } =
      requestToken === ETHER_TOKEN_FAKE_ADDRESS ? ETHER_DATA : await getTokenData(requestToken, settings)

    const { timestamp } = await app.web3Eth('getBlock', blockNumber).toPromise()

    return {
      ...state,
      requests: [
        ...requests,
        {
          requestId,
          requesterAddress,
          depositToken,
          depositDecimals,
          depositName,
          depositSymbol,
          depositAmount,
          requestToken,
          requestDecimals,
          requestName,
          requestSymbol,
          requestAmount,
          requestTokenId,
          reference,
          status: requestStatus.PENDING,
          date: marshallDate(timestamp),
        },
      ],
    }
  } catch (err) {
    console.log(err)
  }
}

async function requestRefunded(state, { requestId }) {
  const { requests } = state
  const nextStatus = requestStatus.WITHDRAWN
  return {
    ...state,
    requests: await updateRequestStatus(requests, requestId, nextStatus),
  }
}
async function requestFinalised(state, { requestId }) {
  const { requests } = state
  const nextStatus = requestStatus.APPROVED

  return {
    ...state,
    requests: await updateRequestStatus(requests, requestId, nextStatus),
  }
}

/***********************
 *                     *
 *       Helpers       *
 *                     *
 ***********************/

async function getTokenData(tokenAddress, settings) {
  const [decimals, name, symbol] = await Promise.all([
    loadTokenDecimals(tokenAddress, settings),
    loadTokenName(tokenAddress, settings),
    loadTokenSymbol(tokenAddress, settings),
  ])
  return {
    decimals,
    name,
    symbol,
    address: tokenAddress,
  }
}

async function updateRequestStatus(requests, requestId, nextStatus) {
  const requestIndex = requests.findIndex(request => request.requestId === requestId)

  if (requestIndex !== -1) {
    const nextRequests = Array.from(requests)
    nextRequests[requestIndex] = {
      ...nextRequests[requestIndex],
      status: nextStatus,
    }
    return nextRequests
  } else {
    console.error(`Tried to update request #${requestId} that shouldn't exist!`)
  }
}

async function loadTokenName(tokenAddress, { network }) {
  const fallback = tokenDataFallback(tokenAddress, 'name', network.type) || ''
  let name
  try {
    name = (await getTokenName(app, tokenAddress)) || fallback
  } catch (err) {
    // name is optional
    name = fallback
  }
  return name
}

async function loadTokenSymbol(tokenAddress, { network }) {
  const fallback = tokenDataFallback(tokenAddress, 'symbol', network.type) || ''

  let symbol
  try {
    symbol = (await getTokenSymbol(app, tokenAddress)) || fallback
  } catch (err) {
    // symbol is optional
    symbol = fallback
  }
  return symbol
}

async function loadTokenDecimals(tokenAddress, { network }) {
  const fallback = tokenDataFallback(tokenAddress, 'decimals', network.type) || '0'

  let decimals
  try {
    decimals = (await getTokenDecimals(app, tokenAddress)) || fallback
  } catch (err) {
    // decimals is optional
    decimals = fallback
  }
  return decimals
}

function marshallDate(date) {
  // Represent dates as real numbers, as it's very unlikely they'll hit the limit...
  // Adjust for js time (in ms vs s)
  return parseInt(date, 10) * 1000
}
