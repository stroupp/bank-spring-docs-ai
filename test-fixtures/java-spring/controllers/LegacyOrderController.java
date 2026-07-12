package fixture.order;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api")
public class LegacyOrderController {

    @RequestMapping(
        path = {"/orders/{orderId}", "/legacy/orders/{orderId}"},
        method = RequestMethod.GET
    )
    public ResponseEntity<OrderResponse> getOrder(
        @PathVariable(name = "orderId") Long orderId,
        @RequestParam(name = "includeHistory", defaultValue = "false", required = false) boolean includeHistory,
        @RequestHeader(value = "X-Tenant-Id", required = true) String tenantId) {
        return ResponseEntity.ok().build();
    }
}
