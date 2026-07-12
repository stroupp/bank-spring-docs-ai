package fixture.customer;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "risk-service")
public interface CustomerRiskClient {
    @GetMapping("/api/risk/customers/{customerId}")
    RiskResponse checkRisk(@PathVariable Long customerId);
}
