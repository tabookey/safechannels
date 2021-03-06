pragma solidity ^0.5.10;

import "gsn-sponsor/contracts/GsnForwarder.sol";


//for testing: GsnForwarder which is called directly, not via relay.
contract MockGsnForwarder is GsnForwarder {

    // Just so truffle can parse the event when call wrapped by 'mockCallRecipient'
    event SmartAccountCreated(address sender, address smartAccount, bytes32 smartAccountId);

    constructor(IRelayHub hub) GsnForwarder(hub, IRelayRecipient (0)) public {
    }
    //mock callRecipient, with custom sender
    function mockCallRecipient(address sender, address recipient, bytes calldata func ) external {
        bytes memory funcWithSender = abi.encodePacked(func,sender);
        (bool res,bytes memory ret) = recipient.call(funcWithSender);
        require(res,string(ret));
    }

    //we mock ourselves as "valid" relay hub - setHubAddress checks it.
    function balanceOf(address) pure public returns(uint) {
        return 0;
    }
}
