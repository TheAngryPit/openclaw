import Foundation
import GRDB
import OpenClawKit

extension OpenClawClientDatabases {
    static func storeSessionRoutingIdentity(
        _ identity: OpenClawChatSessionRoutingIdentity,
        gatewayID: String,
        in db: Database) throws
    {
        try db.execute(
            sql: """
            INSERT INTO gateway_routing_identity(
                gateway_id, scope, main_session_key, default_agent_id, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(gateway_id) DO UPDATE SET
                scope = excluded.scope,
                main_session_key = excluded.main_session_key,
                default_agent_id = excluded.default_agent_id,
                updated_at = excluded.updated_at
            """,
            arguments: [
                gatewayID, identity.scope, identity.mainSessionKey, identity.defaultAgentID,
                Date().timeIntervalSince1970,
            ])
    }
}
